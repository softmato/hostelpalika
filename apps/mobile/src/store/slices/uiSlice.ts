import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ThemePreference = "dark" | "light" | "system";

/**
 * Which calendar the hostel portal writes its dates in.
 *
 * `"BS"` is Bikram Sambat — `Bhadra 2, 2083 BS`. `"AD"` is Gregorian — `18 Aug
 * 2026`. It is a **display** preference and nothing else: every date still
 * crosses the wire as an ISO instant, and every period is still the server's
 * `2026-08`. Nothing here changes what is stored, only what is read.
 */
export type CalendarPreference = "AD" | "BS";

export type UiState = {
  calendarPreference: CalendarPreference;
  themePreference: ThemePreference;
};

const initialState: UiState = {
  /*
   * Bikram Sambat by default. This is a Nepali product.
   *
   * It used to default to Gregorian, on the argument that AD was what every
   * screen already printed and flipping it would reformat dates a hostel had
   * been reading for months. That argument protects the upgrade and loses the
   * user: BS is the civil calendar here — it is what a rent month is called out
   * loud, what a notice board is dated in, and what an owner writes in the
   * ledger — so defaulting to AD asked every single person to change a setting
   * before the app spoke their calendar, and almost nobody found it.
   *
   * The reformat is still real, which is why `store/index.ts` carries a
   * migration rather than letting the change reach only fresh installs, and why
   * the setting sits in the shared Settings screen where anyone can put it
   * back. See `hooks/use-dates.ts` for how the choice reaches the screens.
   */
  calendarPreference: "BS",
  /*
   * Light by default, deliberately — not "system".
   *
   * Following the OS would hand a dark app to anyone whose phone is in dark
   * mode, and the product's identity is the white-and-green surface the website
   * uses. Dark is a setting people opt into, so the two audiences that matter
   * (a first-time resident, and a hostel owner comparing the app to the site)
   * both see the same thing.
   */
  themePreference: "light",
};

const uiSlice = createSlice({
  initialState,
  name: "ui",
  reducers: {
    setCalendarPreference(state, action: PayloadAction<CalendarPreference>) {
      state.calendarPreference = action.payload;
    },
    setThemePreference(state, action: PayloadAction<ThemePreference>) {
      state.themePreference = action.payload;
    },
  },
});

export const { setCalendarPreference, setThemePreference } =
  uiSlice.actions;

export default uiSlice.reducer;
