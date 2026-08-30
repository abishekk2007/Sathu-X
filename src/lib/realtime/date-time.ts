// ---------------------------------------------------------------------------
// Phase 6A — Date/time utilities. Deterministic, timezone-aware, no network.
//
// Rules:
//   - Always states the timezone used (IANA name + UTC offset label). Never
//     silently assumes local is UTC (or vice versa).
//   - Default timezone is the server process timezone via Intl — but it is
//     ALWAYS labelled in the answer, so it is never "silently" anything.
//   - Specific calendar-date queries ("what day is 2026-12-25") resolve the
//     weekday against UTC, because the calendar date is absolute.
// ---------------------------------------------------------------------------

export interface DateTimeInfo {
  tzName: string;
  offsetLabel: string;
  iso: string;
  dateText: string;
  dayOfWeek: string;
  timeText: string;
}

export interface DateQueryOutput {
  target: Date;
  label: string;
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const CITY_TIMEZONES: Record<string, string> = {
  "new york": "America/New_York",
  "nyc": "America/New_York",
  washington: "America/New_York",
  boston: "America/New_York",
  chicago: "America/Chicago",
  "los angeles": "America/Los_Angeles",
  "la": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  denver: "America/Denver",
  phoenix: "America/Phoenix",
  toronto: "America/Toronto",
  montreal: "America/Toronto",
  vancouver: "America/Vancouver",
  mexico: "America/Mexico_City",
  "mexico city": "America/Mexico_City",
  lima: "America/Lima",
  bogota: "America/Bogota",
  sao: "America/Sao_Paulo",
  "sao paulo": "America/Sao_Paulo",
  rio: "America/Sao_Paulo",
  london: "Europe/London",
  dublin: "Europe/Dublin",
  lisbon: "Europe/Lisbon",
  madrid: "Europe/Madrid",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  frankfurt: "Europe/Berlin",
  rome: "Europe/Rome",
  milan: "Europe/Rome",
  amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels",
  vienna: "Europe/Vienna",
  zurich: "Europe/Zurich",
  geneva: "Europe/Zurich",
  stockholm: "Europe/Stockholm",
  oslo: "Europe/Oslo",
  copenhagen: "Europe/Copenhagen",
  helsinki: "Europe/Helsinki",
  warsaw: "Europe/Warsaw",
  prague: "Europe/Prague",
  athens: "Europe/Athens",
  istanbul: "Europe/Istanbul",
  moscow: "Europe/Moscow",
  kiev: "Europe/Kyiv",
  kyiv: "Europe/Kyiv",
  dubai: "Asia/Dubai",
  abu: "Asia/Dubai",
  doha: "Asia/Qatar",
  riyadh: "Asia/Riyadh",
  tel: "Asia/Jerusalem",
  jerusalem: "Asia/Jerusalem",
  karachi: "Asia/Karachi",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  kolkata: "Asia/Kolkata",
  chennai: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  dhaka: "Asia/Dhaka",
  colombo: "Asia/Colombo",
  bangkok: "Asia/Bangkok",
  jakarta: "Asia/Jakarta",
  singapore: "Asia/Singapore",
  hong: "Asia/Hong_Kong",
  "hong kong": "Asia/Hong_Kong",
  beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai",
  tokyo: "Asia/Tokyo",
  osaka: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  taipei: "Asia/Taipei",
  manila: "Asia/Manila",
  kuala: "Asia/Kuala_Lumpur",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  brisbane: "Australia/Brisbane",
  perth: "Australia/Perth",
  auckland: "Pacific/Auckland",
  honolulu: "Pacific/Honolulu",
  "new delhi": "Asia/Kolkata",
};

/** Default timezone: the server process timezone, always spelled out in answers. */
export function defaultTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved && resolved.length > 0 ? resolved : "UTC";
  } catch {
    return "UTC";
  }
}

/** True when `tz` is a valid IANA timezone the runtime can format in. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a "in <city>/<IANA zone>" mention inside a message to an IANA
 * timezone id, or null when nothing recognizable is found. Longest alias
 * wins so "san francisco" beats "san".
 */
export function resolveTimeZone(query: string): string | null {
  const lower = query.toLowerCase();
  // Surface punctuation ("in Chennai?") must not defeat the $-anchored match.
  const cleanedLower = lower.replace(/[?!.]+$/, "").trim();

  // Direct IANA id, e.g. "in Asia/Kolkata" or "in America/New_York".
  const iana = query.match(/\b([A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\/-]+)\b/);
  if (iana && isValidTimeZone(iana[1])) return iana[1];

  const inMatch = cleanedLower.match(/\bin\s+([a-z][a-z .'’-]{1,39})$/i);
  let candidate = inMatch ? inMatch[1] : null;
  if (!candidate) {
    // Also accept "current time <city>" without the "in" preposition.
    const bare = cleanedLower.match(/\b(?:time|clock)\s+(?:in\s+)?([a-z][a-z .'’-]{1,39})$/i);
    candidate = bare ? bare[1] : null;
  }
  if (!candidate) return null;

  const cleaned = candidate
    .trim()
    .replace(/[?!.]+$/, "")
    .replace(/\s+(?:please|right\s+now|now)\s*$/, "")
    .trim();
  return lookupCity(cleaned);
}

function lookupCity(candidate: string): string | null {
  if (!candidate) return null;
  const words = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  // Longest→shortest prefix match (e.g. "san francisco usa" → "san francisco").
  for (let end = words.length; end >= 1; end -= 1) {
    const key = words.slice(0, end).join(" ");
    if (CITY_TIMEZONES[key]) return CITY_TIMEZONES[key];
  }
  return null;
}

function formatParts(now: Date, tz: string): DateTimeInfo {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  let offsetLabel = part("timeZoneName").replace(/^GMT/, "UTC");
  if (/^[+-]\d/.test(offsetLabel)) offsetLabel = `UTC${offsetLabel}`;
  if (offsetLabel && !/^UTC/.test(offsetLabel) && !/^[+-]/.test(offsetLabel)) {
    offsetLabel = `UTC ${offsetLabel}`;
  }

  return {
    tzName: tz,
    offsetLabel: offsetLabel || "UTC",
    iso: now.toISOString(),
    dateText: `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`,
    dayOfWeek: part("weekday"),
    timeText: `${part("hour")}:${part("minute")}:${part("second")}`,
  };
}

/** Current date/time information for `now` in `tz` (IANA). States the tz. */
export function getDateTimeInfo(now: Date, tz: string): DateTimeInfo {
  const resolved = isValidTimeZone(tz) ? tz : defaultTimeZone();
  return formatParts(now, resolved);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Weekday of an absolute calendar date, resolved in UTC (unambiguous). */
export function weekdayForCalendarDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
  });
  return formatter.format(date);
}

function buildCalendarDate(
  year: number,
  month: number,
  day: number
): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Parses a date-plus-arm query ("tomorrow", "in 10 days", "what day is
 * 2026-12-25", "28 August 2026") into a target Date + human label, or null
 * when the message isn't such a query.
 */
export function computeDateQuery(query: string, now: Date): DateQueryOutput | null {
  const lower = query.toLowerCase();
  let target: Date | null = null;
  let label = "";

  if (/\bday\s+after\s+tomorrow\b/.test(lower)) {
    target = addDays(now, 2);
    label = "The day after tomorrow";
  } else if (/\btomorrow\b/.test(lower)) {
    target = addDays(now, 1);
    label = "Tomorrow";
  } else if (/\bday\s+before\s+yesterday\b/.test(lower)) {
    target = addDays(now, -2);
    label = "The day before yesterday";
  } else if (/\byesterday\b/.test(lower)) {
    target = addDays(now, -1);
    label = "Yesterday";
  }

  if (!target) {
    const relative = lower.match(/\bin\s+(\d+)\s+(days?|weeks?|months?|years?)\b/);
    if (relative) {
      const count = Number.parseInt(relative[1], 10);
      const unit = relative[2] ?? "days";
      const base = new Date(now.getTime());
      if (unit.startsWith("day")) {
        target = addDays(base, count);
      } else if (unit.startsWith("week")) {
        target = addDays(base, count * 7);
      } else if (unit.startsWith("month")) {
        target = new Date(base.getFullYear() + Math.floor(count / 12), base.getMonth() + (count % 12), base.getDate());
      } else {
        target = new Date(base.getFullYear() + count, base.getMonth(), base.getDate());
      }
      label = `In ${count} ${unit}`;
    }
  }

  if (!target) {
    const iso = lower.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (iso) {
      target = buildCalendarDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      label = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    }
  }

  if (!target) {
    const dayMonth = lower.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+(\d{4})?\b/
    );
    const monthDay = lower.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})?\b/
    );
    if (dayMonth && MONTHS[dayMonth[2]] !== undefined) {
      const day = Number(dayMonth[1]);
      const year = Number(dayMonth[3] ?? now.getFullYear());
      if (day >= 1 && day <= 31) {
        target = buildCalendarDate(year, MONTHS[dayMonth[2]], day);
        label = `${dayMonth[1]} ${dayMonth[2]} ${year}`;
      }
    } else if (monthDay && MONTHS[monthDay[1]] !== undefined) {
      const day = Number(monthDay[2]);
      const year = Number(monthDay[3] ?? now.getFullYear());
      if (day >= 1 && day <= 31) {
        target = buildCalendarDate(year, MONTHS[monthDay[1]], day);
        label = `${monthDay[1]} ${monthDay[2]} ${year}`;
      }
    }
  }

  if (!target || Number.isNaN(target.getTime())) return null;
  return { target, label };
}