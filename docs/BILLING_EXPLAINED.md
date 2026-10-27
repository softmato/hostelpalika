# How billing works

For the demo script and for owners. Written from the shipped code (field review E4).
Every date is Bikram Sambat; a bill's month is a BS month (`2083-05` = Bhadra 2083).

## 1. Join

The warden registers the resident and, on the last step, picks **Billing**:

- **Calendar month** (default) — from the move-in day to the end of the BS month, then
  one bill per BS month.
- **Same day each month** — from the move-in day to the day before that day next month,
  then one bill every month on that day. The resident page says "Bills on the 20th".

The joining bill (admission fee + deposit) is raised at the same moment, with its own
reference code. The email they typed becomes their login.

## 2. First bill

Raised at registration — nobody has to press anything.

- Calendar month: prorated by days. Rent ÷ days in that BS month × days stayed.
- Same day: the whole rent; the first span is a full month.

## 3. Monthly bill

The billing run is daily, just after Nepal midnight. It bills a calendar resident on the
1st of each BS month and a same-day resident on their own day. Running twice never bills
twice. A bill falls due on the last day it covers — or, when the hostel has a late fine,
on its last fine-free day counted from the bill's first day. Credit from an overpayment,
khata items, days away and Resident Offer fee-off all land on this bill.

## 4. Reminders

Automatic, twice a day (08:00 and 21:00 Nepal): 7 and 5 days before the due date, then
twice daily from 3 days before until it is paid. Keyed to the bill's own due date, so
same-day bills are reminded on their own schedule.

## 5. Late fine

If the hostel turns it on: after the free days, a FINE line is added to the bill every
day it stays unpaid (a fixed amount or a percent per day). Staff can waive it.

## 6. Moving out

The resident gives notice in the app or on the web: a day at least the hostel's
**move-out notice days** ahead, and an optional reason. No approval. Admin and wardens are
told at once; the resident can change or cancel until the day. Rent stops on that day.
The day before and on the day, the resident and the warden get a push. On the day the
warden's Home shows "Leaving today" → **Move out** opens the move-out sheet on that date:
the leaving bill is cut to the day (or charged in full if the hostel chose that), later
bills are cancelled, the deposit decision is recorded, and the login goes back to public.

## Worked example

Rent 6,200 a month. Bhadra 2083 has 31 days, Aswin 31, Kartik 30. No late fine.

**Calendar month — Asha**

| When | What | Amount |
|---|---|---|
| Bhadra 20 | Registered. First bill: Bhadra 20–31, 12 of 31 days, due Bhadra 31 | 2,400 |
| Aswin 1 | Aswin bill, due Aswin 31 | 6,200 |
| Aswin 24 / 26 / 28–31 | Reminders while unpaid | — |
| Aswin 25 | Gives notice: leaving Kartik 10 (hostel needs 7 days) | — |
| Kartik 1 | Kartik bill, already cut: Kartik 1–10, 10 of 30 days | 2,067 |
| Kartik 9 / 10 | "Moving out tomorrow / today" to Asha and the warden | — |
| Kartik 10 | Warden: Home → Leaving today → Move out | — |

**Same day each month — Bikash**, also joining Bhadra 20:

| When | What | Amount |
|---|---|---|
| Bhadra 20 | First bill: Bhadra 20 – Aswin 19, whole month, due Aswin 19 | 6,200 |
| Aswin 20 | Next bill: Aswin 20 – Kartik 19 · bills on the 20th | 6,200 |

With a late fine of 5 free days on, Asha's Aswin bill would fall due on Aswin 5 instead,
and a fine line would start on Aswin 6 if it was still unpaid.
