/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The calendar preference has one source, and this is what keeps it that way.
 *
 * The node types are referenced explicitly because Expo's base tsconfig does not
 * load them — this is the only test here that reads the source tree rather than
 * calling into it.
 *
 * ## Why a test that reads the source tree
 *
 * `uiSlice.calendarPreference` decides whether the app spells dates in Bikram
 * Sambat or Gregorian. It reaches screens through `useDates()`, which is the
 * *only* correct way to render a date anywhere under `app/` — and nothing
 * stopped a screen from importing `formatDate` from `lib/format.ts` instead,
 * which silently prints Gregorian for ever.
 *
 * That is not hypothetical. The statement screen printed one month twice in two
 * calendars on the same card, and `manage/statements.tsx` printed the raw
 * `2026-09` period key beside a formatted date. Both passed review and both
 * typechecked, because there is nothing about either a type can catch.
 *
 * So the rule is checked mechanically. The checks are deliberately crude — they
 * read imports, not semantics — because a crude check that runs on every commit
 * beats a precise one nobody writes.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where the calendar preference is in force: **the whole UI layer**.
 *
 * This was `["app/(admin)", "app/manage"]` while the setting was the hostel
 * owner's alone. Now the default is Bikram Sambat for everybody, so a resident's
 * Payments screen, a cook's photo log and a guardian's dashboard are all bound by
 * the same rule — see `hooks/use-dates.ts`.
 *
 * `components/` is walked too, and not as an afterthought: a shared card is the
 * one place a Gregorian date would leak into every role at once.
 */
const SCREEN_DIRS = ["app", "components"];

/**
 * Screens allowed to reach past `useDates()`, and why.
 *
 * Empty, and it should stay that way. Each entry is a date the reader cannot
 * change the calendar of, so think hard before adding one: the two real cases so
 * far — a `YYYY-MM-DD` field someone types into and a six-bar chart axis — both
 * live in `lib/`, which this check does not walk, precisely because neither is a
 * date being *read*.
 */
const ALLOWED: Record<string, readonly string[]> = {};

/**
 * Date formatters that pick a calendar for you, and therefore ignore the
 * setting.
 *
 * `formatTime` is absent on purpose — Bikram Sambat is a calendar, not a clock,
 * and the time of day is the same string in both. So are `formatDateBoth` and
 * `formatPeriodBoth`, which show both calendars deliberately, and
 * `nepalPeriodKey` / `nepalDayKey`, which are identities rather than labels.
 */
const CALENDAR_BLIND = [
  "formatAgo",
  "formatDate",
  "formatDateBs",
  "formatDateTime",
  "formatDayMonth",
  "formatDayMonthBs",
  "formatPeriod",
  "formatPeriodBs",
  "formatPeriodMonth",
  "formatPeriodMonthBs",
  "formatPeriodYear",
  "formatPeriodYearBs",
  "formatRelativeDay",
  "formatYear",
  "formatYearBs",
];

/** Repo-relative and forward-slashed, so a failure reads the same on any OS. */
function label(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);

      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (/\.tsx?$/.test(child) && !child.endsWith(".test.ts")) {
        found.push(child);
      }
    }
  };

  walk(join(SRC, dir));

  return found;
}

/**
 * The names a file pulls out of one module — `type` prefixes and aliases removed.
 *
 * Found by string search rather than by a regex built from a template, which is
 * how the first version of this silently matched nothing: `\s` inside a
 * template literal is an escape for the letter `s`, so the pattern was looking
 * for `imports*{`. A check that quietly passes is worse than no check.
 */
function importedFrom(source: string, module: string): string[] {
  const at = source.indexOf(`from "${module}"`);

  if (at < 0) {
    return [];
  }

  const close = source.lastIndexOf("}", at);
  const open = source.lastIndexOf("{", close);

  if (close < 0 || open < 0 || !source.slice(0, open).trimEnd().endsWith("import")) {
    return [];
  }

  return source
    .slice(open + 1, close)
    .split(",")
    .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
    .filter(Boolean);
}

describe("the app has one source of truth for dates", () => {
  it("has no screen formatting a date behind the setting's back", () => {
    const offenders: string[] = [];

    for (const dir of SCREEN_DIRS) {
      for (const file of sourceFiles(dir)) {
        const allowed = ALLOWED[label(file)] ?? [];
        const blind = importedFrom(readFileSync(file, "utf8"), "@/lib/format").filter(
          (name) => CALENDAR_BLIND.includes(name) && !allowed.includes(name),
        );

        if (blind.length > 0) {
          offenders.push(`${label(file)} imports ${blind.join(", ")}`);
        }
      }
    }

    // The fix is `useDates()` and `dates.date` / `dates.dateTime` / `dates.period`
    // / `dates.relativeDay` / `dates.ago`. If a date on one of these screens
    // genuinely must be Gregorian, say why in a comment and add it to `ALLOWED`
    // rather than working around it.
    expect(offenders).toEqual([]);
  });

  it("offers no calendar setting: there is one date format", () => {
    // `Baisakh · 2083-01-15` everywhere (docs/PORTAL_POLISH_2026_10.md). A
    // picker back on a settings screen would be a switch that changes nothing.
    const screens = ["app/settings.tsx", "app/manage/settings.tsx"];

    const offering = screens.filter((screen) =>
      readFileSync(join(SRC, screen), "utf8").includes("<CalendarPreferenceCard />"),
    );

    expect(offering).toEqual([]);
  });

  it("converts to Bikram Sambat in exactly one place", () => {
    // Every BS string in the app comes from `toNepaliDate` in `lib/format.ts`.
    // A second `new NepaliDate(...)` is a second chance to hand the converter a
    // `Date` whose *local* fields are the wrong day — the bug that made a phone
    // set to Auckland read every Nepali date one day ahead of the English one
    // printed beside it.
    const constructions = sourceFiles("lib")
      .filter((file) => readFileSync(file, "utf8").includes("new NepaliDate("))
      .map(label);

    expect(constructions).toEqual(["lib/format.ts"]);
  });

  it("states Nepal's UTC offset exactly once", () => {
    // `lib/manage-dates.ts` and `lib/food-week.ts` each carried their own
    // `5 * 60 + 45`. Three copies is three places to fix a bug in one of them.
    const declarations = [...sourceFiles("lib"), ...sourceFiles("hooks")]
      .filter((file) =>
        /(?:const|let)\s+NEPAL_OFFSET_MINUTES\s*=/.test(readFileSync(file, "utf8")),
      )
      .map(label);

    expect(declarations).toEqual(["lib/format.ts"]);
  });

  it("names a Gregorian month from one table", () => {
    // `lib/admin-home.ts` and `lib/payment-months.ts` each held a private
    // twelve-string array, so "what is month 08 called" had three answers.
    const tables = sourceFiles("lib")
      .filter((file) => /(?:const|let)\s+MONTHS?_(?:SHORT|LONG|NAMES)\s*=/.test(
        readFileSync(file, "utf8"),
      ))
      .map(label);

    expect(tables).toEqual(["lib/format.ts"]);
  });
});
