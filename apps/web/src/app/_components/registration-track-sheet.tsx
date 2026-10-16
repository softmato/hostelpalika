"use client";

import { Loader2 } from "@/components/icons";
import type { PresenceChannel } from "pusher-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { BrandMark } from "@/components/brand-mark";
import { browserApi } from "@/lib/browser-api";
import { TRACK_SHEET_CHANNEL, TRACK_SHEET_EVENT } from "@/lib/realtime/channels";
import {
  AGREEMENT_STATUSES,
  blankLine,
  cleanLineCell,
  holdersOf,
  isBlankLine,
  lineFrom,
  linesFrom,
  placesOf,
  readLines,
  withRefPreview,
  type LineColumn,
  type Place,
  type SheetLine,
  type TrackSheetView,
} from "@/modules/team/registration-track-sheet";

import { InitialsAvatar, RoleButton, SearchField } from "./portal-dashboard-ui";
import { focusCell, SheetGrid, type SheetGridColumn } from "./sheet-grid";

/**
 * The hostel registration track sheet — every agreement Softmato signs, one
 * line each, shared live by everyone on the team. Types like the
 * existing-residents sheet because it is that sheet (`SheetGrid`).
 *
 * Presence rides a Pusher presence channel: who has the page open comes from
 * the channel, which line each of them is on is relayed through
 * `…/registration-track-sheet/focus`, and a save tells the others to reload.
 *
 * A line somebody is on is theirs: everyone who arrives after them sees it
 * tinted with their name and can't type in it until they move off it or save.
 * Switching to another window doesn't count as moving off — only the cursor
 * going somewhere else on this page, or the page closing.
 */

const API = "/api/v1/team/registration-track-sheet";

const COLUMNS: (SheetGridColumn & { key: LineColumn })[] = [
  { key: "hostelName", label: "Hostel name", width: 220 },
  { key: "location", label: "Location", width: 180 },
  { key: "ownerName", label: "Owner name", width: 170 },
  { inputMode: "tel", key: "phone", label: "Phone", width: 130 },
  { key: "refCode", label: "Ref code", readOnly: true, width: 150 },
  { key: "signedOn", label: "Signed on", width: 120 },
  { key: "signedBy", label: "Signed by", readOnly: true, width: 150 },
  { key: "status", label: "Status", options: () => [...AGREEMENT_STATUSES], width: 110 },
  { key: "notes", label: "Notes", width: 280 },
];

type Member = { email: string; id: string; image: string | null; name: string };

type MemberData = { id: string; info?: { email?: string; image?: string | null; name?: string } };

/** The app icon in a spinning ring — the Google sign-in wait, while the sheet opens. */
export function TrackSheetLoader({ message }: { message?: string }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="relative flex size-20 items-center justify-center rounded-2xl bg-brand-teal/10">
        <BrandMark className="h-8 animate-pulse" />
        <div className="absolute -inset-2.5 animate-spin rounded-3xl border-2 border-brand-teal/20 border-t-brand-teal" />
      </div>
      {message ? (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Opening the track sheet…</p>
      )}
    </div>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function RegistrationTrackSheet() {
  const { confirm, confirmDialog } = useConfirm();
  const [lines, setLines] = useState<SheetLine[] | null>(null);
  const [nextSequence, setNextSequence] = useState(1);
  const [you, setYou] = useState("");
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState({ column: 0, row: 0 });
  const [onGrid, setOnGrid] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  // userId → the line they are on.
  const [focus, setFocus] = useState<Record<string, Place>>({});
  // Where the server last heard I was, and since when.
  const [mine, setMine] = useState<Place | null>(null);

  // Read by socket handlers, which are bound once.
  const editedRef = useRef(edited);
  const removedRef = useRef(removed);
  const savingRef = useRef(false);
  const liveRef = useRef(false);
  const placeRef = useRef<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const mineRef = useRef<Place | null>(null);
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    editedRef.current = edited;
    removedRef.current = removed;
  }, [edited, removed]);

  /** The sheet as saved — after a colleague's save, with what is typed here and not saved yet kept. */
  const apply = useCallback((view: TrackSheetView) => {
    setNextSequence(view.nextSequence);
    setYou(view.you);
    setLines((current) => {
      if (!current) return linesFrom(view.rows);

      const typed = new Map(current.filter((line) => editedRef.current.has(line.key)).map((line) => [line.key, line]));
      const known = new Set(current.map((line) => line.id));
      const saved = view.rows
        .filter((row) => !removedRef.current.has(row.id))
        .map((row) => typed.get(row.id) ?? lineFrom(row));
      let arrived = view.rows.filter((row) => !known.has(row.id) && !removedRef.current.has(row.id)).length;
      // New lines land above the empty ones: drop as many empty lines, so what is
      // typed here keeps its line number. Never the one the cursor is in.
      const drafts = current.filter((line) => {
        if (line.id) return false;
        if (arrived > 0 && isBlankLine(line) && line.key !== cursorRef.current) {
          arrived -= 1;

          return false;
        }

        return true;
      });

      return [...saved, ...drafts];
    });
    // Lines above the cursor may have moved it down; the focused box itself stays put.
    requestAnimationFrame(() => {
      const at = (document.activeElement as HTMLElement | null)?.dataset?.cell?.split(":").map(Number);

      if (at) setActive({ column: at[1]!, row: at[0]! });
    });
  }, []);

  useEffect(() => {
    browserApi<TrackSheetView>(API)
      .then(apply)
      .catch((cause: unknown) => setMessage(errorText(cause)));
  }, [apply]);

  const announce = useCallback((force = false) => {
    const line = placeRef.current;

    if (!liveRef.current || (!force && line === sentRef.current)) return;

    sentRef.current = line;
    // Said again for a newcomer, it keeps the time I got there, so who came first still holds.
    const at = force && mineRef.current?.line === line ? mineRef.current.at : undefined;

    browserApi<Place>(`${API}/focus`, { body: JSON.stringify({ at, line }), method: "POST" })
      .then((place) => {
        mineRef.current = place;
        setMine(place);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    async function connect() {
      let config: { cluster: string; enabled: boolean; key: string };

      try {
        config = await browserApi<typeof config>("/api/v1/realtime/config");
      } catch {
        return;
      }

      if (cancelled || !config.enabled || !config.key) return;

      const { default: Pusher } = await import("pusher-js");

      if (cancelled) return;

      const client = new Pusher(config.key, { authEndpoint: "/api/v1/realtime/auth", cluster: config.cluster });
      const channel = client.subscribe(TRACK_SHEET_CHANNEL) as PresenceChannel;
      const readMembers = () => {
        const list: Member[] = [];

        channel.members.each((member: MemberData) =>
          list.push({
            email: member.info?.email ?? "",
            id: member.id,
            image: member.info?.image ?? null,
            name: member.info?.name ?? "Team member",
          }),
        );
        setMembers(list);
      };

      channel.bind("pusher:subscription_succeeded", () => {
        liveRef.current = true;
        setMeId(channel.members.me?.id ?? null);
        readMembers();
        announce();
      });
      channel.bind("pusher:member_added", () => {
        readMembers();
        // The newcomer missed where everyone already is.
        if (placeRef.current) announce(true);
      });
      channel.bind("pusher:member_removed", (member: MemberData) => {
        readMembers();
        setFocus((current) => ({ ...current, [member.id]: { at: 0, line: null } }));
      });
      channel.bind(TRACK_SHEET_EVENT.FOCUS, ({ at, line, userId }: Place & { userId: string }) =>
        setFocus((current) => ({ ...current, [userId]: { at, line } })),
      );
      channel.bind(TRACK_SHEET_EVENT.SAVED, () => {
        // Our own save brings the fresh sheet back with it.
        if (!savingRef.current) {
          browserApi<TrackSheetView>(API)
            .then(apply)
            .catch(() => {});
        }
      });

      cleanup = () => {
        liveRef.current = false;
        channel.unbind_all();
        client.unsubscribe(TRACK_SHEET_CHANNEL);
        client.disconnect();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [announce, apply]);

  const changed = edited.size > 0 || removed.size > 0;

  useEffect(() => {
    if (!changed) return;

    const warn = (event: BeforeUnloadEvent) => event.preventDefault();

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);

  const all = useMemo(() => lines ?? [], [lines]);
  const needle = query.trim().toLowerCase();
  const matches = useCallback(
    (line: SheetLine) =>
      !needle ||
      (!isBlankLine(line) &&
        (line.cells.hostelName.toLowerCase().includes(needle) ||
          Boolean(line.id && line.cells.refCode.toLowerCase().includes(needle)))),
    [needle],
  );
  const cursorKey = onGrid ? (all.filter(matches)[active.row]?.key ?? null) : null;
  const places = useMemo(() => placesOf(all), [all]);
  // Reading somebody else's line never holds it — only a line I can change does.
  const cursorLine = cursorKey ? all.find((line) => line.key === cursorKey) : undefined;
  const myPlace = cursorLine && !cursorLine.readOnly ? (places.get(cursorLine.key) ?? null) : null;

  // place → everyone else on it.
  const others = useMemo(() => {
    const byPlace = new Map<string, (Place & { name: string })[]>();

    for (const [userId, place] of Object.entries(focus)) {
      // On a line, people are named by their email — the one thing that tells two Ramesh apart.
      const member = members.find((item) => item.id === userId);
      const name = member ? member.email || member.name : undefined;

      if (!place.line || userId === meId || !name) continue;
      byPlace.set(place.line, [...(byPlace.get(place.line) ?? []), { ...place, name }]);
    }

    return byPlace;
  }, [focus, meId, members]);

  // A new line somebody is on shows the code it would get, as the cursor's does.
  const showOn = useMemo(() => {
    const keys = new Set(cursorKey ? [cursorKey] : []);

    for (const line of all) {
      if (!line.id && others.has(places.get(line.key) ?? "")) keys.add(line.key);
    }

    return keys;
  }, [all, cursorKey, others, places]);
  const visible = useMemo(
    () =>
      withRefPreview(all, nextSequence, showOn)
        // A new line is signed by whoever saves it — here, you — as it is signed today.
        .map((line) => (line.id ? line : { ...line, cells: { ...line.cells, signedBy: you } }))
        .filter(matches),
    [all, matches, nextSequence, showOn, you],
  );
  const serial = useMemo(() => new Map(all.map((line, index) => [line.key, index + 1])), [all]);
  const read = useMemo(() => readLines(all, edited), [all, edited]);
  const cellErrors = useMemo(
    () => new Map(read.errors.map((error) => [`${error.key}:${error.column}`, error.message])),
    [read],
  );

  const activeLine = onGrid ? visible[active.row] : undefined;

  useEffect(() => {
    placeRef.current = myPlace;
    cursorRef.current = cursorKey;

    // Arrowing down a column shouldn't send a message per line passed.
    const timer = setTimeout(() => announce(), 250);

    return () => clearTimeout(timer);
  }, [announce, cursorKey, myPlace]);

  /** Everyone else on this line, and the ones among them who have it. */
  function presenceOn(line: SheetLine) {
    const place = places.get(line.key) ?? "";
    const here = others.get(place) ?? [];

    return {
      holders: here.length ? holdersOf(place, here, place === myPlace ? mine : null) : [],
      names: here.map((other) => other.name),
    };
  }

  const and = (names: string[]) => `${names.join(" and ")} ${names.length > 1 ? "are" : "is"}`;

  function setCell(key: string, column: LineColumn, value: string) {
    setLines((current) =>
      (current ?? []).map((line) =>
        line.key === key ? { ...line, cells: { ...line.cells, [column]: cleanLineCell(column, value) } } : line,
      ),
    );
    setEdited((current) => (current.has(key) ? current : new Set(current).add(key)));
  }

  async function remove(line: SheetLine) {
    const id = line.id;

    if (id) {
      const ok = await confirm({
        actionLabel: "Delete line",
        description: `${line.cells.refCode} stays used — no other agreement is given it. The line goes when you save.`,
        title: `Delete ${line.cells.hostelName || "this line"}?`,
        tone: "destructive",
      });

      if (!ok) return;
      setRemoved((current) => new Set(current).add(id));
    }

    // A new line is emptied rather than taken out, so the lines under it keep their places for everyone.
    setLines((current) =>
      (current ?? []).flatMap((item) =>
        item.key !== line.key ? [item] : id ? [] : [{ ...blankLine(), key: item.key }],
      ),
    );
    setEdited((current) => {
      const next = new Set(current);

      next.delete(line.key);

      return next;
    });
  }

  async function save() {
    const firstError = read.errors[0];

    if (firstError) {
      const row = visible.findIndex((line) => line.key === firstError.key);

      setMessage(`Line ${serial.get(firstError.key)}: ${firstError.message}`);
      if (row >= 0) focusCell(row, COLUMNS.findIndex((column) => column.key === firstError.column));

      return;
    }

    setSaving(true);
    savingRef.current = true;
    setMessage("");

    try {
      const view = await browserApi<TrackSheetView>(API, {
        body: JSON.stringify({ removed: [...removed], rows: read.rows }),
        method: "PUT",
      });

      setLines(linesFrom(view.rows));
      setNextSequence(view.nextSequence);
      setEdited(new Set());
      setRemoved(new Set());
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }

  if (!lines) return <TrackSheetLoader message={message} />;

  const savedCount = lines.filter((line) => line.id).length;
  const activeColumn = COLUMNS[active.column];
  const activeError = activeLine ? cellErrors.get(`${activeLine.key}:${activeColumn?.key}`) : undefined;
  const activeSerial = activeLine ? serial.get(activeLine.key) : undefined;
  const activeHolders = activeLine ? presenceOn(activeLine).holders : [];

  return (
    <SheetGrid
      actions={
        <>
          <SearchField className="w-64" onChange={setQuery} placeholder="Search hostel or ref code" value={query} />
          <RoleButton disabled={saving || !changed} onClick={() => void save()} tone="team" type="button">
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </RoleButton>
        </>
      }
      active={active}
      cellTitle={(line, column) => cellErrors.get(`${line.key}:${column}`)}
      columns={COLUMNS}
      isFlagged={(line, column) => cellErrors.has(`${line.key}:${column}`)}
      isHeld={(line) => presenceOn(line).holders.length > 0}
      isLocked={(line) => Boolean(line.readOnly)}
      label="Hostel registration track sheet"
      lineNote={(line) => {
        const { holders, names } = presenceOn(line);

        if (holders.length) return `Currently held by ${holders.join(", ")}`;

        return names.length ? `${and(names)} viewing this line` : null;
      }}
      lineNumber={(line) => serial.get(line.key) ?? 0}
      onActiveChange={(cell) => {
        setActive(cell);
        setOnGrid(true);
      }}
      onCellChange={(line, column, value) => setCell(line.key, column as LineColumn, value)}
      onGrow={
        needle ? undefined : () => setLines((current) => [...(current ?? []), ...Array.from({ length: 10 }, () => blankLine())])
      }
      onLeave={() =>
        // Another window taking focus is not leaving the line; only the cursor moving elsewhere on this page is.
        setTimeout(() => {
          if (document.hasFocus()) setOnGrid(false);
        })
      }
      onRemove={(line) => void remove(line)}
      rows={visible}
      status={
        message ? (
          <span className="text-destructive">{message}</span>
        ) : activeError ? (
          <span className="text-warning">
            Line {activeSerial} · {activeError}
          </span>
        ) : activeLine?.readOnly ? (
          <span className="text-muted-foreground">
            Line {activeSerial} · Only {activeLine.cells.signedBy || "the team member who signed it"} or a
            superadmin can change this line.
          </span>
        ) : activeHolders.length ? (
          <span className="text-warning">
            Line {activeSerial} · Currently held by {activeHolders.join(", ")}. It opens when they move off it or save.
          </span>
        ) : activeLine ? (
          <span className="text-muted-foreground">
            Line {activeSerial} ·{" "}
            {activeColumn?.key === "refCode" && !activeLine.id
              ? "The ref code is given when you save"
              : activeColumn?.label}
          </span>
        ) : null
      }
      subtitle={
        members.length ? (
          // Hover or focus the faces for everyone's name.
          <span className="group/people relative mt-1 inline-flex items-center gap-2 outline-none" tabIndex={0}>
            <span className="flex shrink-0 -space-x-1.5">
              {members.map((member) => (
                <InitialsAvatar
                  className="ring-2 ring-background"
                  image={member.image}
                  key={member.id}
                  name={member.name}
                  size="sm"
                  tone="team"
                />
              ))}
            </span>
            {members.length} on this page
            <span className="invisible absolute left-0 top-full z-40 mt-2 w-64 translate-y-1 rounded-xl border border-border bg-card p-1.5 opacity-0 shadow-lg transition duration-150 group-hover/people:visible group-hover/people:translate-y-0 group-hover/people:opacity-100 group-focus-within/people:visible group-focus-within/people:translate-y-0 group-focus-within/people:opacity-100">
              {members.map((member) => (
                <span className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground" key={member.id}>
                  <InitialsAvatar image={member.image} name={member.name} size="sm" tone="team" />
                  <span className="min-w-0 flex-1 truncate">{member.name}</span>
                  {member.id === meId ? <span className="text-[11px] text-muted-foreground">You</span> : null}
                </span>
              ))}
            </span>
          </span>
        ) : null
      }
      summary={
        <>
          {savedCount} {savedCount === 1 ? "agreement" : "agreements"}
          {changed ? " · not saved" : ""}
        </>
      }
      title="Hostel Registration Track Sheet"
    >
      {confirmDialog}
    </SheetGrid>
  );
}
