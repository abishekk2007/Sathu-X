// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: timezone-aware scheduling helpers.
//
// Reuses the existing real-time timezone machinery (src/lib/realtime/date-time.ts)
// — there is deliberately NO new timezone database here. Rules:
//   * every instant is stored as timestamptz UTC (the DB column type),
//   * natural-language due phrases ("tomorrow at 6pm", "next Monday") are
//     resolved in the user's IANA timezone (client-provided or default),
//   * recurrence is computed FORWARD from due_at at read time — rolling
//     "next due" is never persisted.
// ---------------------------------------------------------------------------

import {
  defaultTimeZone,
  isValidTimeZone,
} from "@/lib/realtime/date-time";

export interface DueResolution {
  /** ISO instant (UTC) to store in due_at, or null when no due was stated. */
  dueAt: string | null;
  /** Human phrase used ("tomorrow at 6pm"). */
  sourcePhrase: string;
  /** True when the phrase set an exact moment (not just a day). */
  hasExactTime: boolean;
  /** The explicit resolved zone, or the default zone that was applied. */
  timezone: string;
}

const DAY_MATCH =
  /\b(?:today|tonight|tomorrow|tmr|tmrrow|day after tomorrow|overnight)\b/i;
const WEEKDAY_PATTERN = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
const NEXT_ANCHOR = /\b(?:next|this|coming)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
const TIME_PATTERN =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;
const RELATIVE_PATTERN = /\b(?:in\s+(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks))\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Standard UTC offset of `zone` at `instantMs` (ms; Europe/London winter = 0). */
function zoneOffsetMs(zone: string, instantMs: number): number {
  const wallFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const utcFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const read = (fmt: Intl.DateTimeFormat, type: string) => {
    const parts = fmt.formatToParts(new Date(instantMs));
    const v = Number(parts.find((p) => p.type === type)?.value ?? "0");
    return type === "hour" ? (v === 24 ? 0 : v) : v;
  };
  const wall = Date.UTC(
    read(wallFmt, "year"), read(wallFmt, "month") - 1, read(wallFmt, "day"),
    read(wallFmt, "hour"), read(wallFmt, "minute"), read(wallFmt, "second")
  );
  const utc = Date.UTC(
    read(utcFmt, "year"), read(utcFmt, "month") - 1, read(utcFmt, "day"),
    read(utcFmt, "hour"), read(utcFmt, "minute"), read(utcFmt, "second")
  );
  return wall - utc;
}

/**
 * True-UTC instant for wall-clock components read from `zone`. Two fixed-point
 * iterations are plenty: the offset for a given date only nudges by an hour on
 * DST transitions, so the guess converges in one correction pass.
 */
export function wallClockToInstant(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = zoneOffsetMs(zone, naiveUtc);
  let instant = naiveUtc - offset;
  const corrected = zoneOffsetMs(zone, instant);
  if (corrected !== offset) {
    instant = naiveUtc - corrected;
  }
  return instant;
}

/** Wall-clock parts of `instantMs` read from `zone`. */
function wallParts(zone: string, instantMs: number) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const read = (type: string) => {
    const v = Number(parts.find((p) => p.type === type)?.value ?? "0");
    return type === "hour" ? (v === 24 ? 0 : v) : v;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function normalizeWeekday(token: string): string {
  const t = token.toLowerCase();
  const aliases: Record<string, string> = {
    mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday",
    thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday",
    sat: "saturday", sun: "sunday",
  };
  return aliases[t] ?? t;
}

function nextWeekday(now: Date, weekday: string): number {
  const target = WEEKDAYS.indexOf(normalizeWeekday(weekday));
  const current = now.getDay();
  let diff = (target - current + 7) % 7;
  if (diff === 0) diff = 7;
  const out = new Date(now);
  out.setDate(out.getDate() + diff);
  return out.getTime();
}

function parseClockTime(text: string): { hour: number; minute: number } | null {
  const m = text.match(TIME_PATTERN);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const period = (m[3] ?? "").toLowerCase();
  if (hour < 1 || hour > 23 || minute > 59) return null;
  if (period.startsWith("am") && hour === 12) hour = 0;
  if (period.startsWith("pm") && hour < 12) hour += 12;
  return { hour, minute };
}

/**
 * Resolves a natural-language due phrase to a true-UTC instant in `timezone`.
 * Deterministic and timezone-aware; when no resolvable anchor exists, it
 * returns { dueAt: null } so the caller answers honestly instead of guessing.
 */
export function resolveDuePhrase(
  phrase: string,
  options: { now?: Date; timezone?: string } = {}
): DueResolution {
  const now = options.now ?? new Date();
  const timezone = options.timezone && isValidTimeZone(options.timezone)
    ? options.timezone
    : defaultTimeZone();
  const sourcePhrase = String(phrase ?? "").trim();

  if (!sourcePhrase) {
    return { dueAt: null, sourcePhrase, hasExactTime: false, timezone };
  }

  // 1. Relative windows ("in 3 days", "in 2 hours") — plain instant math.
  //    Checked first so the amount is never misread as a clock hour.
  const relative = sourcePhrase.match(RELATIVE_PATTERN);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const base = new Date(now);
    if (unit.startsWith("minute")) base.setMinutes(base.getMinutes() + amount);
    else if (unit.startsWith("hour")) base.setHours(base.getHours() + amount);
    else if (unit.startsWith("day")) base.setDate(base.getDate() + amount);
    else if (unit.startsWith("week")) base.setDate(base.getDate() + amount * 7);
    return {
      dueAt: base.toISOString(),
      sourcePhrase,
      hasExactTime: false,
      timezone,
    };
  }

  const clock = parseClockTime(sourcePhrase);
  const hasExactTime = clock !== null;

  // 2. "next/this/coming <weekday>" — absolute day anchor.
  const nextAnchor = sourcePhrase.match(NEXT_ANCHOR);
  if (nextAnchor) {
    const anchorMs = nextWeekday(now, nextAnchor[1]);
    return {
      dueAt: resolveAt(now, new Date(anchorMs), clock, timezone),
      sourcePhrase,
      hasExactTime,
      timezone,
    };
  }

  // 3. Bare weekday / day tokens.
  const dayToken = sourcePhrase.toLowerCase().match(DAY_MATCH)?.[0];
  const weekdayToken = sourcePhrase.match(WEEKDAY_PATTERN)?.[0];
  if (dayToken) {
    let dayMs: number;
    if (dayToken === "today" || dayToken === "tonight" || dayToken === "overnight") {
      dayMs = now.getTime();
    } else if (dayToken === "tomorrow" || dayToken === "tmr" || dayToken === "tmrrow") {
      dayMs = now.getTime() + 86_400_000;
    } else {
      dayMs = now.getTime() + 2 * 86_400_000;
    }
    return {
      dueAt: resolveAt(now, new Date(dayMs), clock, timezone),
      sourcePhrase,
      hasExactTime,
      timezone,
    };
  }
  if (weekdayToken) {
    return {
      dueAt: resolveAt(now, new Date(nextWeekday(now, weekdayToken)), clock, timezone),
      sourcePhrase,
      hasExactTime,
      timezone,
    };
  }

  return { dueAt: null, sourcePhrase, hasExactTime: false, timezone };
}

/** Builds the target instant for a wall-clock day: exact time or end of day. */
function resolveAt(now: Date, day: Date, clock: { hour: number; minute: number } | null, timezone: string): string {
  if (clock) {
    const instant = wallClockToInstant(
      timezone,
      day.getFullYear(),
      day.getMonth() + 1,
      day.getDate(),
      clock.hour,
      clock.minute
    );
    return new Date(instant).toISOString();
  }
  // No stated time → end of that LOCAL day (23:59), so "due Monday" keeps the
  // whole of Monday available without leaking into the next day.
  const instant = wallClockToInstant(
    timezone,
    day.getFullYear(),
    day.getMonth() + 1,
    day.getDate(),
    23,
    59
  );
  return new Date(instant).toISOString();
}

/** Sendable display time for react/UI strings (server-computed, timezone-aware). */
export function formatDueLabel(dueAt: string | null, timezone?: string): string {
  if (!dueAt) return "";
  const zone = timezone && isValidTimeZone(timezone) ? timezone : defaultTimeZone();
  const date = new Date(dueAt);
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const today = wallParts(zone, now.getTime());
  const due = wallParts(zone, date.getTime());
  const sameDay = today.year === due.year && today.month === due.month && today.day === due.day;
  const prefix = sameDay ? "Today" : new Date(due.year, due.month - 1, due.day) > new Date(today.year, today.month - 1, today.day) ? read("weekday") : "Overdue";
  return `${prefix} ${read("day")} ${read("month")}, ${read("hour")}:${read("minute")}`;
}

/**
 * Next due instant for a recurring task strictly after `afterMs`, anchored to
 * the original due_at. Cron-like and forward-only. Returns null for 'none'.
 */
export function nextRecurrenceDue(
  recurrence: "none" | "daily" | "weekly" | "monthly",
  originalDueIso: string,
  afterMs: number
): string | null {
  if (recurrence === "none") return null;
  const original = new Date(originalDueIso).getTime();
  if (!Number.isFinite(original)) return null;
  const intervalMs =
    recurrence === "daily"
      ? 86_400_000
      : recurrence === "weekly"
        ? 7 * 86_400_000
        : 30 * 86_400_000;
  const steps = Math.floor((afterMs - original) / intervalMs) + 1;
  return new Date(original + steps * intervalMs).toISOString();
}