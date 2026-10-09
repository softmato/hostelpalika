# HostelPalika promo films — playbook

How the **public** film (v2, 112 s, 16:9 + 9:16) was made, what went wrong on the
way, and the shortest path to the next three: **hostel admin**, **resident**, and the
**branch** segment (needs the account that has branches).

Everything lives in `marketing/video/`:

```
.env                    ELEVENLABS_API_KEY (gitignored — never paste keys in chat)
tts.mjs                 node tts.mjs <voiceId> <out.mp3> <text.txt>   (Nepali TTS)
sfx.mjs                 node sfx.mjs <outDir>   (soft UI sound kit; skips files that exist)
capture/rec.sh          `source` it: adb recorder + touch logger + helpers
capture/ui.mjs          uiautomator queries: find / list / centroid / empty / spread
audio/public, audio/v2  narration .txt + .mp3 per line
assets/raw/clips        phone recordings (.mp4) + touch logs (.touches)
assets/cfr              30 fps copies used by the build
public-film/            HyperFrames project (16:9) — build/ holds the generator
public-film-vertical/   9:16 project; its assets/ is a junction to public-film/assets
```

Not in git (see `.gitignore`): phone recordings + pulled PDFs (`assets/raw`), their
30 fps copies, scene cuts, renders, snapshots. On a fresh clone, recreate the junction
(PowerShell): `New-Item -ItemType Junction -Path public-film-vertical\assets -Target public-film\assets`.
Rebuilding a film needs the raw clips, so keep `assets/raw` backed up outside git.
The HyperFrames agent skills (`.agents/`, `skills-lock.json`) are gitignored too; on a
new machine reinstall them with `npx skills add heygen-com/hyperframes`.

---

## 0. What the user wants (non-negotiable, learned the hard way)

- **Narration almost wall-to-wall.** v1 had ~10 short lines over 89 s and felt "less
  speech, static, low energy". v2 has 17 lines covering ~90 % of the film. Every
  feature gets **two sentences**: a question/pain, then what the app does.
- **A suspense opening**, cinematic and professional, before any UI. Then a sharp
  pain hook. **Offer 3–4 hook options** with a preview and let the user pick (they
  picked "A · Pain trio"). Ask this *before* building.
- **Language:** Nepali voice. **English loanwords written in Devanagari** —
  म्याप, रुम, फिल्टर, बुक, डाइरेक्सन, भेरिफाइड, कम्पेयर, फेसिलिटी — never the
  pure-Nepali equivalent (नक्सा was rejected). English feature names on screen
  ("Search & Filter"), Nepali headline under them, Nepali subtitles of the voice.
- **Not Kathmandu-only.** Say "नेपालभर", show Pokhara/Nepal-wide before zooming in.
- **Look:** **white background, green (#0a8a4b) as accent only.** Too much green was
  rejected. The only dark part is the ~10 s cold open (neutral charcoal, not green).
- **Illustrations:** PNGs, **soft white clay**, not line icons, not colourful emoji.
  Source: Microsoft Fluent 3D emoji (MIT) → desaturated to white (recipe in §4).
  Only the green check stays coloured.
- **Sound:** a soft, different sound for every tap, pop-in, swipe, transition.
  Never loud. Music must **never thin out or go silent** mid-film.
- **Copy must be true.** No invented numbers or claims. Refund line was checked
  against the receipt PDF wording. Never pay real money in a flow on camera.
- **Voices:** Sunita leads (professional), Bishnu for the deep "promise" lines.
- **Don't burn tokens on simple jobs** (the map take took ~15 screenshots; the user
  called it out). Dry-run once with `ui.mjs list`, then record.

## 1. ElevenLabs

- Pay-as-you-go, 10 k credits/month. Public film v1+v2 used ~650.
- Key permissions needed: Text to Speech, Music, Sound Effects, Voices read, User read.
  (`models_read` was off — fine, not needed.)
- **Max 3 concurrent requests** → run TTS in ≤3 parallel streams.
- Only `mp3_44100_128` on this tier (192 k returns 403).
- **Never pass Devanagari through the shell** — curl in Git Bash mangled UTF-8
  (`invalid_unicode`). Write the line to a `.txt`, call `tts.mjs`.
- TTS: model `eleven_v3`, `language_code: "ne"`.
  Sunita `kiOHzNtCRPG6PpJF256k`, Bishnu `HkUjoHqRfXAnlMzQfp8a`.
  (Other Nepali library voices tried: Prakash, Kaanchi — rejected.)
  ~10–15 credits per line; Sunita speaks ≈ 10 Devanagari chars/second.
- Music: `POST /v1/music` with `music_length_ms`. Prompt by **time-coded sections**
  and say "NO silent gaps, NO breakdowns" — and still **measure** it (§5).
- SFX: `POST /v1/sound-generation`, `duration_seconds` ≥ 0.5. Kit in
  `public-film/assets/sfx`: tap pop whoosh swish paper success shimmer glitch plink
  cross typing sent hit riser reveal — all peak-normalised to −3 dB. Reuse it.

## 2. Capturing the phone (adb)

- Phone is 720×1640, USB debugging on, **Developer options → Stay awake** on.
  Ask the user to unlock; never type their PIN/passwords.
- `source capture/rec.sh` then:
  `rec_start <clip> <maxSeconds>` … `tap x y` / `swipe x1 y1 x2 y2 ms` / `tapt "Label"` /
  `type_slow text` / `key BACK|66` … `rec_stop` → `assets/raw/clips/<clip>.mp4` +
  `<clip>.touches` (time-stamped, so the film draws a finger exactly where it tapped).
  `sheet <clip> N` makes a contact sheet in the scratchpad for a quick check.
- **Dry-run first, without recording**: navigate, `node capture/ui.mjs list`, get
  coordinates, back out, then record the whole flow in one take.
- Gotchas:
  - Git Bash rewrites `/sdcard/...` → set `MSYS_NO_PATHCONV=1` (rec.sh does).
  - No `bc` / `pkill` in Git Bash.
  - `ui.mjs` ignores container nodes with long labels (the map's marker list).
  - Leaflet double-tap zoom only works as `adb shell "input tap x y & sleep .12; input tap x y"`
    (`dtap`). `zoomin <px>` keeps zooming until markers spread over N px.
  - After typing in a search box, `key 66` (Enter) hides the keyboard; otherwise
    it covers the result card.
  - `adb input` lands ~0.4 s after the logged time (`TOUCH_LAG` in config).
  - The Android status bar (60 px) is cropped; the film draws a clean 9:41 bar.
- Data hygiene: ask the user to hide test records before recording (they hid
  "Test Hostel 1" + branch). 20/31 public hostels are `isDemoData` — feature real
  ones in close-ups. The admin account may hold **live** data: type, don't submit,
  unless the user says it's safe.

## 3. The film's structure (public v2 — reuse the shape)

| Part | Time | What |
|---|---|---|
| Cold open (dark charcoal) | 0–10 | Bishnu: the big human problem; white-clay PNG story (house → bus → hostels); dots of light; the one-line question huge ("कहाँ बस्ने?") |
| Pain hook | 10–19 | Sunita: three quick pains on three 3D cards (glitching photo, unanswered chat, ten crossed-out pins), word-timed captions |
| Reveal | 19–30 | Bishnu "अब यो झन्झट छैन।" in the music's silence → **light burst on the drop** → logo, wordmark on "HostelPalika", tagline, feature pills; Sunita one-line positioning |
| 8 feature scenes | 30–100 | Each: kinetic **word card** wipe ("Search.") → phone with real footage + finger ripples, eyebrow `01 · Discover`, English title, Nepali headline, chips, one white-clay sticker, subtitles of the 2-sentence line |
| Close | 100–112 | three promises with green checks → minis fan up → lockup "HostelPalika — होस्टल खोज्ने नयाँ तरिका" → URL |

For **admin**, the user's own order: **Overview → Resident management → Finance
(expenses, stock, statements, credit/debit khata, receipts) → Staff → Reports (PDF)**,
then branches in a later take with the other account. Lead with the owner's pain:

1. मालिक अर्कै काममा व्यस्त — होस्टलको हिसाब हेर्नै भ्याउनुहुन्न।
2. कापी, WhatsApp, Excel मा छरिएको रेकर्ड — कसले तिर्‍यो, कसले तिरेन थाहा हुँदैन।
3. हरेक महिना बाँकी शुल्क माग्न धाउनुपर्ने, रसिद हराउने।
4. खर्च, स्टक, उधारो — नाफा कति? अनुमान मात्र।
5. स्टाफलाई फोनैफोनमा निर्देशन।
6. अभिभावकको चिन्ता; प्रशासनले विवरण माग्दा कागज खोज्दै हैरान
   (DAO Kathmandu directive asks for updated resident details — say "records always
   ready", never "legally compliant").
Promise line: होस्टल व्यवस्थापन अब एउटै मोबाइल, एउटै एपबाट। Pull admin PDFs
(statement, performance, receipts) with `adb pull /sdcard/Download/HostelPalika/`
and render them with PyMuPDF for the "report flies out of the phone" beat.

## 4. Building it (HyperFrames)

- Generator, not hand-written HTML: `node public-film/build/build.mjs landscape|portrait`
  writes `index.html` into each project.
  - `config.mjs` — scenes, voice lines (`at` seconds into the scene, `sub: true` for
    subtitles), footage ranges per scene. **Phone scenes last `voice + 1 s`; footage is
    retimed to fit** (speed clamped 0.75–4×, last frame held). `decimate: true`
    removes frozen waits (map).
  - `segments.mjs` cuts/crops/retimes footage (ffmpeg) and maps touch logs.
  - `hook.mjs` cold/hook/logo · `phone.mjs` phone rig, whips, word cards, stickers,
    extras · `end.mjs` · `styles.mjs` · `layout.mjs` (16:9 vs 9:16 geometry) ·
    `emit.mjs` helpers.
- **For admin: copy `public-film/` → `admin-film/` and edit config + the
  scene-specific extras.** Better: first lift the shared parts (phone rig, word cards,
  subtitles, audio mix, end) so each film is just a config + its hook. Do that
  refactor at the start of the next session.
- 3D PNGs: `assets/png` (colour, Fluent 3D, MIT) → `assets/pngw` (white):
  `ffmpeg -i in.png -vf "format=rgba,hue=s=0,eq=brightness=0.22:contrast=0.62:gamma=1.15" out.png`.
  Get more from `https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/<Name>/3D/<name>_3d.png`
  (person variants live under `<Name>/Default/3D/..._3d_default.png`). Useful for admin:
  Money bag, Chart increasing, Clipboard, Ledger, Bar chart, Card index, Bell, Key,
  Shield, Receipt, Busts in silhouette, Office worker.
- Lint gotchas we hit (`npx hyperframes lint`):
  - never a CSS `transform` on something GSAP animates — use `rotate:` or set it in the tween.
  - a `fromTo` that reveals a hidden element must put `opacity:1` in the **to** vars.
  - overlapping SFX on one track → the builder assigns free lanes (`data-track-index` 20+).
  - a section authored in its own clock → `const h = gsap.timeline(); … tl.add(h, shift)`.
  - background-clip:text dies on transformed children — put the style on each `.ch`.
- Review: `npx hyperframes snapshot --at t1,t2,… --no-end --describe false` and read the
  contact sheet. Render: `npx hyperframes render -o renders/<name>.mp4` (~7.5 min each
  locally; run both formats in one background command).

## 5. Audio mix

- Voice `data-volume` 1.15; music ducks **0.9 → 0.5** under voice (v1's 0.55 → 0.2
  made the music vanish). SFX 0.12–0.45.
- **Measure music** before use (RMS per 2 s):
  `ffmpeg -i m.mp3 -ac 1 -ar 8000 -f s16le - | python -c "...rms per 16000 samples..."`.
  Splice out dips on beat boundaries (108 BPM → 0.5556 s) with `atrim` + 0.12 s
  `acrossfade`; extend by looping a groove section the same way.
- Find the track's **drop** (RMS per 0.25 s) and offset the music so the drop lands on
  the visual reveal; put the line before the drop in the track's pre-drop silence.

## 5b. Admin film (v1, 215 s) — what changed, reuse it

- **Shared code is `lib/`** (`film.mjs` pipeline, `phone.mjs` rig, `segments.mjs`, `end.mjs`,
  `styles.mjs`, `emit.mjs`). A film's `build/` is just `config.mjs` + its hook + `extras.mjs`
  (+ `theme.mjs`). public-film rebuilds byte-identical on the lib.
- **Close-ups** (`focus` in config): `{tap: n}` / `{src: [clip, s]}` / `{at}` + x, y, k, hold.
  The camera flies the phone to frame centre, the screen frosts (4 blurred panels + green ring —
  a backdrop-filter *mask* renders black in Chrome, don't use one) and consecutive close-ups pan.
  Prefer `src:` times — `at:` drifts whenever a voice line changes length.
- **Ring sync (v1 bug):** a tap close-up arrives 0.8 s *before* the logged tap and the ring
  clears 0.22 s after it — the screen changes 0–1 s after a tap, so a ring held longer sits on
  the next screen. One ring at a time. Rings fit the component: `lib/detect.mjs` flood-fills the
  real frame from the tap point; full-width rows / big buttons leak, so give those a measured
  `box: [x, y, w, h]` (recording px). Check with `BOXES=1 node build.mjs` → draw boxes on frames.
- Footage you didn't record with `rec.sh` has no touch log: write one, and **measure** tap
  times from scene changes (`select='gt(scene,0.03)',showinfo`) — guessed times were 1 s off.
- A close-up must also end inside the moment it shows: if the list scrolls or the scene cuts
  while the ring is up, it lands on the wrong row (and past its blur window).
- **`blur`** boxes per seg hide phone numbers on lists (only where the list is still).
- **Look:** moving mesh (lavender / mint / cream on white), black type, green accent, white glass
  cards with odometer numbers. User's reference: soft gradient blobs, "not joker colours".
- **Voices:** eleven_v3 **emotion tags** (`[curious]`, `[warmly]`, `[excited]`, `[confident]`)
  and conversational phrasing ("अनि…", "हेर्नुहोस्…") — v1 lines read like bullet points. Then
  speed up 1.1× (Sunita) / 1.05× (Bishnu). Subtitles strip the tags. Mukta drops ह्वा → write व्हा.
- **Portal beats:** after each staff/resident admin scene, a short scene on *their* phone
  (`badge: "Warden's phone"`); the user logs into each account in turn.
- **adb traps hit:** BACK on the home screen exits the app; a "Call" tap opens the dialer
  (personal recents) — cut before it; a missed field tap + BACK walks into the launcher.
  Always check `mInputShown` before using BACK to hide a keyboard.
- `music.mjs` generates music; the track had its own break+drop at 32 s → start offset so the
  drop lands on the burst, cut dips on the bar grid, loop a groove block to reach the length.

## 6. Process — do it in this order next time

1. Read this file + memory. Confirm the user is logged in on the phone and the screen
   is awake.
2. Explore the portal on the phone **once** with `ui.mjs list` + a few screenshots;
   list features → propose categories + the problem list (Nepali) + 4 hook options.
   Get approval in one round (AskUserQuestion), including which records to hide.
3. Write the full narration script (two sentences per feature, loanwords in
   Devanagari) and get a quick OK; generate all lines (≤3 parallel).
4. Record every clip (dry-run → one take each). Contact-sheet check only.
5. Generate music for the film length, measure, splice, align drop.
6. Build both formats, lint, snapshot ~10 key times, fix, render, deliver both.
7. Ask for notes; iterate.
