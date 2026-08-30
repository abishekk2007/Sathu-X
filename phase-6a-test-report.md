# Phase 6A — Real-Time Intelligence Test Report

**Date:** 2026-08-28
**Suite:** `test-phase6a.ts` — run via `npx tsx test-phase6a.ts`
**Result:** **224 passed / 224 total (0 failed)**

---

## Overview of what is automated

`test-phase6a.ts` is a self-contained, deterministic unit suite. It uses injected
fetch stubs (`makeFetch`, `openMeteoStub`, `jsonResponse`, `hangingFetch`) and an
injectable clock (`now`) so no live network call, provider key, database, or browser
is touched. The suite exits non-zero on any failure.

| Section | Covers | Assertions |
|---|---|---|
| A. Intent routing | Deterministic routing, document-reference priority (now **unconditional**), planning/task guard words, time/date guards, weather location extraction (in/for/at/how-is/lead), live-chat phrasings (possessive `today's`, trailing `?`, forecast/temperature forms, location-less prompt), currency patterns, injection rejection | ~72 |
| B. Date/time utilities | `defaultTimeZone`, `isValidTimeZone`/IANA passthrough (case preserved), city-alias resolution (longest-prefix), `computeDateQuery` (tomorrow, relative "in N days/weeks/months/years", ISO, named dates), `weekdayForCalendarDate`, offset-label normalization (`GMT+02:00` → `UTC+02:00`), trailing-punctuation tz resolution | ~9 |
| C. Calculator | Arithmetic + precedence, parens, sqrt/pow, decimal handling, divide-by-zero, malformed/trailing operators, injection strings (process.exit, import, fetch, require, Math.random, 1e308…), input/token/depth/result bounds, formatted output never NaN/Infinity/undefined | ~23 |
| D. Weather tool | **Keyless Open-Meteo**: no-API-key success, current (measured temp + `Source: Open-Meteo` + `Checked:` label), 5-day forecast with WMO condition mapping + rain probability, geocode 500, geocode 404 → upstream, empty-result `location_not_found`, bounded timeout retry on geocode, malformed forecast → `weather_malformed`, short-TTL cache (per kind + coords), user-scoped cache keys, per-kind cache separation, generic city resolution, location-less → `location_required` prompt | ~50 |
| E. Currency tool | not-configured (no call), conversion computed from provider rate (`100 USD = 8,422.50 EUR`, rate reported), rate-only, upstream 500, invalid key (never retried), 429 not hot-looped, timeout, malformed, short-TTL cache, user-scoping, routed end-to-end, unparseable pair → safe guidance without guessing | ~28 |
| F. Security & grounding | API keys never leak into answers, internal provider URLs/hosts hidden, tools never throw (divide-by-zero, unknown intent), grounding block embeds the measured value verbatim with no-invention rules, plain deterministic answer path | ~11 |

Total assertions: **224**.

## Verified behaviors (asserted, not eyeballed)

- `detectRealtimeIntent` stands down for **any** explicit document/PDF/notes reference
  ("according to my PDF", "what date does my PDF mention?", "what does my document say
  about …") — even when no sources are attached. Document context always wins.
- Real live-chat phrasings that previously fell through to Gemini now intercept:
  `What is today's date?`, `What's today's date?`, `What is todays date?`,
  `What date is it?`, `What is today's day?`, `Today's date?` → `CURRENT_DATE`;
  `What time is it in Chennai?` → `CURRENT_TIME` with tz `Asia/Kolkata`;
  `What is the weather in Chennai?` / `What's the weather for Chennai?` →
  `WEATHER_CURRENT` with `location=Chennai` (trailing `?` tolerated);
  `Will it rain tomorrow in Chennai?` / `What's the weather tomorrow in Mumbai?` →
  `WEATHER_FORECAST` with correct location (no longer hijacked to a date query);
  `How hot is Chennai?` → `WEATHER_CURRENT`.
- Location-less weather questions ("What is the weather?") route to a
  `location_required` failure whose message asks "Which location should I check?" —
  never guessed coordinates, never Gemini-invented.
- Open-Meteo is **keyless**: D1 asserts a full success path with no `WEATHER_API_KEY`
  configured. Weather providers degrade to safe typed errors (`location_not_found`,
  `weather_upstream_error`, `weather_timeout_or_unreachable`, `weather_malformed`,
  `weather_rate_limited`) — no keys, URLs, or stack traces ever surface.
- WMO codes map deterministically (51 → "Light drizzle", 95 → "Thunderstorm", …) —
  no LLM interpretation layer.
- Provider adapters respect test knobs: timeouts abort via `AbortController`, retries are
  bounded (max 2), and invalid-key / 429 / 4xx responses are never retried.
- Caches are short-TTL and strongly keyed (`realtime:openmeteo:{userId}:{kind}:{lat}:{lon}`,
  geocode `realtime:geocode:open-meteo:{userId}:{location}`,
  `realtime:currency:{userId}:{from}:{to}`); tests assert a second call is served from
  cache, that kind separates (forecast refetches), and that a different user forces a
  fresh call.
- Every failed path returns a structured, user-safe message.

## Status legend

**AUTOMATED** — covered by this suite: intent routing (incl. live chat phrasings),
date/time math, calculator, provider success/failure/timeout/cache semantics,
security/grounding.

**LIVE API — VERIFIED IN THIS SESSION** (real network, no stubs, `npx tsx` against the
real endpoints):
1. Open-Meteo geocoding `geocoding-api.open-meteo.com/v1/search?name=Chennai&count=5`
   → `results[0]` `name=Chennai, latitude 13.08784, longitude 80.27847,
   country=India, admin1=Tamil Nadu, timezone=Asia/Kolkata`.
2. Open-Meteo forecast `api.open-meteo.com/v1/forecast?…&timezone=auto&forecast_days=5`
   → `timezone=Asia/Kolkata`, `current.{time,temperature_2m,relative_humidity_2m,
   apparent_temperature,precipitation,weather_code,wind_speed_10m}` and
   `daily.{time[],weather_code[],temperature_2m_max[],precipitation_probability_max[],…}`.
3. End-to-end via `fetchRealtimeWeather` against the live API:
   Chennai current (35°C, Mainly clear, humidity, wind, precipitation, "Checked"
   label with local time + timezone, `Source: Open-Meteo`), 5-day forecast with
   rain chances, cache-hit on repeat call, `location_required` for empty location,
   `location_not_found` for an unknown place. **No API key was used.**

**BROWSER — MANUAL (still required)** — cannot be exercised from this environment
(no browser automation). Confirmed by code inspection only that `chat-workspace.tsx`
reads the `/api/chat` response as plain text, so a direct realtime answer (plain-text
200) needs zero frontend changes.

**NOT TESTED** — out of scope for this suite:
- Real-world provider quota/network behavior beyond simulated responses + the single
  live smoke run above (real throttling is manual-only).
- Non-Latin city/currency spellings and exotic IANA aliases beyond the bundled map.
- Multi-user cache isolation under live concurrent load (unit-tested via user-scoped keys).

---

## Full run (final)

```
==================================================================
PHASE 6A — REAL-TIME INTELLIGENCE TEST REPORT
==================================================================
Passed: 224
Failed: 0
Total:  224
==================================================================
Phase 6A test suite PASSED.
```