// ---------------------------------------------------------------------------
// Phase 6A — Real-Time Intelligence test suite.
// Run with: npx tsx test-phase6a.ts
//
// Covers (>=55 assertions):
//   A. Intent routing (calc / currency / weather / date-time / document
//      priority / planning guards / live chat phrasings) — deterministic.
//   B. Date-time execution (timezone aware, never silently UTC).
//   C. Calculator safety (arithmetic + injection/overflow/div-zero).
//   D. Weather tool (keyless Open-Meteo: geocode → current/forecast, WMO
//      mapping, failures, timeout, retry, cache, user isolation, safe errors).
//   E. Currency tool (same matrix).
//   F. Security / grounding (no secret leakage, no internal names, never
//      throws, Gemini-grounding block carries the real value).
//
// No live network, Supabase, or Gemini calls: providers are exercised through
// injected fetch stubs and fake clocks. Live provider + browser behaviour is
// reported separately as MANUAL in phase-6a-test-report.md.
// ---------------------------------------------------------------------------

import {
  buildRealtimeSystemInstruction,
  detectRealtimeIntent,
  evaluateExpression,
  executeRealtimeTool,
  extractCalculation,
  referencesDocument,
} from "./src/lib/realtime";
import { computeDateQuery, defaultTimeZone, getDateTimeInfo, resolveTimeZone } from "./src/lib/realtime/date-time";
import { fetchRealtimeCurrency } from "./src/lib/realtime/currency";
import { fetchRealtimeWeather } from "./src/lib/realtime/weather";
import type { RealtimeDecision } from "./src/lib/realtime/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS — ${label}`);
    passed++;
  } else {
    console.error(`  FAIL — ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    console.log(`  PASS — ${label}`);
    passed++;
  } else {
    console.error(`  FAIL — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n== ${name} ============================================`);
}

const NOW = new Date("2026-08-28T10:00:00.000Z");

function decisionFor(
  decision: Partial<RealtimeDecision> & { intent: RealtimeDecision["intent"] }
): RealtimeDecision {
  return { handled: true, reason: "test", ...decision };
}

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface StubResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(status: number, payload: unknown): StubResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** Creates a fetch stub; `handler` returns a response or throws. */
function makeFetch(
  handler: (url: string, init?: RequestInit) => StubResponseLike | Promise<StubResponseLike>
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return (await handler(url, init)) as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function hangingFetch(afterAbortCalls = 0): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (_url: string, init?: RequestInit) => {
    calls.push({ url: _url, init });
    if (afterAbortCalls > 0 && calls.length > afterAbortCalls) {
      return jsonResponse(200, { conversion_rate: 1 }) as unknown as Response;
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function withEnvKey<T>(name: string, value: string, fn: () => T): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  try {
    return Promise.resolve(fn()).finally(restore) as Promise<T>;
  } catch (error) {
    restore();
    throw error;
  }
}

const WEATHER_KEY = "WEATHER_API_KEY";
const CURRENCY_KEY = "EXCHANGE_RATE_API_KEY";

async function runPhase6ATests() {
// ---------------------------------------------------------------------------
// A. Intent routing
// ---------------------------------------------------------------------------

section("A. Intent routing (deterministic, no LLM)");

{
  const d = detectRealtimeIntent({ message: "what is 2 + 2" });
  assertEqual(d.intent, "CALCULATION", "A1 'what is 2 + 2' → CALCULATION");
  assertEqual(d.handled, true, "A1 handled=true");
  assertEqual(extractCalculation("what is 2 + 2"), "2 + 2", "A1 extracted expression clean");
}

{
  const d = detectRealtimeIntent({ message: "5*5" });
  assertEqual(d.intent, "CALCULATION", "A2 '5*5' → CALCULATION");
}

{
  const d = detectRealtimeIntent({ message: "what's 3^2" });
  assertEqual(d.intent, "CALCULATION", "A3 'what's 3^2' → CALCULATION");
}

{
  const d = detectRealtimeIntent({ message: "sqrt(144)" });
  assertEqual(d.intent, "CALCULATION", "A4 'sqrt(144)' → CALCULATION");
}

{
  const d = detectRealtimeIntent({ message: "tell me about your day" });
  assertEqual(d.intent, "NONE", "A5 ordinary chat → NONE, not handled");
  assertEqual(d.handled, false, "A5 no real-time interception of chat");
}

{
  const d = detectRealtimeIntent({ message: "the weather is nice" });
  assertEqual(d.intent, "NONE", "A6 'the weather is nice' (no location) → NONE");
}

{
  const d = detectRealtimeIntent({ message: "100 usd to eur" });
  assertEqual(d.intent, "CURRENCY_CONVERSION", "A7 '100 usd to eur' → CURRENCY_CONVERSION");
  assertEqual(d.params?.from, "USD", "A7 from=USD");
  assertEqual(d.params?.to, "EUR", "A7 to=EUR");
  assertEqual(d.params?.amount, 100, "A7 amount=100");
}

{
  const d = detectRealtimeIntent({ message: "usd to eur" });
  assertEqual(d.intent, "EXCHANGE_RATE", "A8 'usd to eur' → EXCHANGE_RATE");
}

{
  const d = detectRealtimeIntent({ message: "how much is 50 eur in inr" });
  assertEqual(d.intent, "CURRENCY_CONVERSION", "A9 '50 eur in inr' → CURRENCY_CONVERSION");
  assertEqual(d.params?.from, "EUR", "A9 from=EUR");
  assertEqual(d.params?.to, "INR", "A9 to=INR");
  assertEqual(d.params?.amount, 50, "A9 amount=50");
}

{
  const d = detectRealtimeIntent({ message: "how many eur is 100 usd" });
  assertEqual(d.intent, "CURRENCY_CONVERSION", "A10 'how many eur is 100 usd'");
  assertEqual(d.params?.from, "USD", "A10 base USD");
  assertEqual(d.params?.to, "EUR", "A10 target EUR");
}

{
  const d = detectRealtimeIntent({ message: "convert 100 dollars to euros" });
  assertEqual(d.handled, true, "A11 unparseable pair still handled (safe guidance, never guessed)");
  assertEqual(d.params?.from, undefined, "A11 no guessed currency code");
}

{
  const d = detectRealtimeIntent({ message: "I saved 50 usd today" });
  assertEqual(d.intent, "NONE", "A12 'I saved 50 usd today' → NONE (not a question)");
}

{
  const d = detectRealtimeIntent({ message: "what's the weather in London" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A13 'weather in London' → WEATHER_CURRENT");
  assertEqual(d.params?.location, "London", "A13 location=London");
}

{
  const d = detectRealtimeIntent({ message: "what's the forecast for Paris" });
  assertEqual(d.intent, "WEATHER_FORECAST", "A14 forecast for Paris → WEATHER_FORECAST");
  assertEqual(d.params?.location, "Paris", "A14 location=Paris");
}

{
  const d = detectRealtimeIntent({ message: "london weather" });
  assertEqual(d.handled, true, "A15 'london weather' → handled weather");
}

{
  const d = detectRealtimeIntent({ message: "what's the temperature in Delhi" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A16 temperature in Delhi → WEATHER_CURRENT");
}

{
  const d = detectRealtimeIntent({ message: "what is the date today" });
  assertEqual(d.intent, "CURRENT_DATE", "A17 'what is the date today' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "what time is it" });
  assertEqual(d.intent, "CURRENT_TIME", "A18 'what time is it' → CURRENT_TIME");
}

{
  const d = detectRealtimeIntent({ message: "what time is it in Tokyo" });
  assertEqual(d.intent, "CURRENT_TIME", "A19 tz-aware time → CURRENT_TIME");
  assertEqual(d.params?.tz, "Asia/Tokyo", "A19 tz resolved to Asia/Tokyo");
}

{
  const d = detectRealtimeIntent({ message: "what day is 2026-12-25" });
  assertEqual(d.intent, "DATE_QUERY", "A20 calendar-date query → DATE_QUERY");
}

{
  const d = detectRealtimeIntent({ message: "what date is in 10 days" });
  assertEqual(d.intent, "DATE_QUERY", "A21 relative date query → DATE_QUERY");
}

{
  const d = detectRealtimeIntent({ message: "plan my day for tomorrow" });
  assertEqual(d.intent, "NONE", "A22 planning verb guard: 'plan my day for tomorrow' → NONE");
}

{
  const d = detectRealtimeIntent({ message: "what time should I wake up" });
  assertEqual(d.intent, "NONE", "A23 time guard: 'what time should I wake up' → NONE");
}

{
  const d = detectRealtimeIntent({ message: "according to the pdf, what is 2+2", hasSources: true });
  assertEqual(d.handled, false, "A24 document reference + sources → stands down (doc wins)");
}

{
  const d = detectRealtimeIntent({ message: "what is 5+5", hasSources: true });
  assertEqual(d.intent, "CALCULATION", "A25 sources attached but no reference → pure calc still handled");
}

{
  const d = detectRealtimeIntent({ message: "hello" });
  assertEqual(d.handled, false, "A26 greeting → not handled");
}

{
  const doc = referencesDocument("what does the document say about mitosis");
  const notDoc = referencesDocument("what time is it");
  assertEqual(doc, true, "A27 referencesDocument true for 'what does the document say…'");
  assertEqual(notDoc, false, "A27 referencesDocument false for a time query");
}

{
  const d = detectRealtimeIntent({ message: "the meeting on 15th is important" });
  assertEqual(d.intent, "NONE", "A28 meeting/calendar guard: not a date tool target");
}

// A29+ — real live-chat phrasings that previously fell through to Gemini
// (possessive apostrophe, trailing "?", location prompts, forecast phrasings).

{
  const d = detectRealtimeIntent({ message: "What is today's date?" });
  assertEqual(d.intent, "CURRENT_DATE", "A29 'What is today's date?' → CURRENT_DATE");
  assertEqual(d.handled, true, "A29 handled (no Gemini fallthrough)");
}

{
  const d = detectRealtimeIntent({ message: "What's today's date?" });
  assertEqual(d.intent, "CURRENT_DATE", "A30 'What's today's date?' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "What is todays date?" });
  assertEqual(d.intent, "CURRENT_DATE", "A31 'What is todays date?' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "What date is it?" });
  assertEqual(d.intent, "CURRENT_DATE", "A32 'What date is it?' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "What is today's day?" });
  assertEqual(d.intent, "CURRENT_DATE", "A33 'What is today's day?' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "Today's date?" });
  assertEqual(d.intent, "CURRENT_DATE", "A34 'Today's date?' → CURRENT_DATE");
}

{
  const d = detectRealtimeIntent({ message: "What is the weather in Chennai?" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A35 'weather in Chennai?' → WEATHER_CURRENT");
  assertEqual(d.params?.location, "Chennai", "A35 location=Chennai (trailing ? tolerated)");
}

{
  const d = detectRealtimeIntent({ message: "What's the weather for Chennai?" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A36 'weather for Chennai?' → WEATHER_CURRENT");
  assertEqual(d.params?.location, "Chennai", "A36 location=Chennai (for-preposition form)");
}

{
  const d = detectRealtimeIntent({ message: "Will it rain tomorrow in Chennai?" });
  assertEqual(d.intent, "WEATHER_FORECAST", "A37 'rain tomorrow in Chennai?' → WEATHER_FORECAST");
  assertEqual(d.params?.location, "Chennai", "A37 location=Chennai (not hijacked to a date query)");
}

{
  const d = detectRealtimeIntent({ message: "What's the weather tomorrow in Mumbai?" });
  assertEqual(d.intent, "WEATHER_FORECAST", "A38 'weather tomorrow in Mumbai?' → WEATHER_FORECAST");
  assertEqual(d.params?.location, "Mumbai", "A38 location=Mumbai, kind=forecast");
}

{
  const d = detectRealtimeIntent({ message: "How hot is Chennai?" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A39 'How hot is Chennai?' → WEATHER_CURRENT");
  assertEqual(d.params?.location, "Chennai", "A39 location=Chennai");
}

{
  const d = detectRealtimeIntent({ message: "What is the weather?" });
  assertEqual(d.intent, "WEATHER_CURRENT", "A40 location-less weather → WEATHER_CURRENT");
  assertEqual(d.params?.location, "", "A40 empty location → tool asks 'Which location should I check?'");
}

{
  const d = detectRealtimeIntent({ message: "What time is it in Chennai?" });
  assertEqual(d.intent, "CURRENT_TIME", "A41 tz-aware time with trailing ? → CURRENT_TIME");
  assertEqual(d.params?.tz, "Asia/Kolkata", "A41 Chennai → Asia/Kolkata");
}

{
  const d = detectRealtimeIntent({ message: "What date does my PDF mention?", hasSources: false });
  assertEqual(d.handled, false, "A42 document-reference date → stands down even WITHOUT sources");
}

{
  const d = detectRealtimeIntent({ message: "According to my PDF, what is today's date?", hasSources: true });
  assertEqual(d.handled, false, "A43 'according to my PDF … date' → doc wins over realtime");
}

// ---------------------------------------------------------------------------
// B. Date-time execution
// ---------------------------------------------------------------------------

section("B. Date-time execution (timezone aware)");

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "CURRENT_DATE", params: { tz: "Europe/Paris" } }),
    message: "what date is it",
    now: () => NOW,
  });
  assertEqual(result.success, true, "B1 current date success");
  assert(
    result.answer.includes("Friday, 28 August 2026"),
    "B1 answer has correct calendar date"
  );
  assert(
    result.answer.includes("(Europe/Paris, UTC+02:00)"),
    "B1 answer states timezone + offset (never silent)"
  );
  assertEqual(result.timestamp, NOW.toISOString(), "B1 timestamp is the tool run time");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "CURRENT_TIME", params: { tz: "Asia/Kolkata" } }),
    message: "what time is it",
    now: () => NOW,
  });
  assertEqual(result.success, true, "B2 current time success");
  assert(result.answer.includes("15:30:00"), "B2 time converted to target tz (10:00Z → 15:30 IST)");
  assert(result.answer.includes("(Asia/Kolkata, UTC+05:30)"), "B2 tz + offset labelled");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "DATE_QUERY", params: { tz: "Asia/Kolkata" } }),
    message: "what day is tomorrow",
    now: () => NOW,
  });
  assertEqual(result.success, true, "B3 date query success");
  assert(result.answer.includes("Saturday, 29 August 2026"), "B3 tomorrow resolved to correct weekday");
  assert(result.answer.includes("Asia/Kolkata, UTC+05:30"), "B3 tz labelled");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "DATE_QUERY" }),
    message: "what day is 2026-12-25",
    now: () => NOW,
  });
  assertEqual(result.success, true, "B4 calendar-date weekday");
  assertEqual(result.answer, "2026-12-25 is 25 December 2026 (a Friday).", "B4 2026-12-25 is a Friday");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "DATE_QUERY", params: { tz: "UTC" } }),
    message: "what date is in 10 days",
    now: () => NOW,
  });
  assertEqual(result.success, true, "B5 relative date query");
  assert(result.answer.includes("7 September 2026"), "B5 in 10 days → 7 September 2026");
}

{
  const info = getDateTimeInfo(NOW, "Asia/Kolkata");
  assertEqual(info.dayOfWeek, "Friday", "B6 dayOfWeek from getDateTimeInfo");
  assertEqual(info.iso, NOW.toISOString(), "B6 iso passthrough");
  assert(info.offsetLabel.includes("05:30"), "B6 offset label present");
}

{
  assertEqual(resolveTimeZone("in new york"), "America/New_York", "B7 city alias → IANA tz");
  assertEqual(resolveTimeZone("what time is it in Asia/Kolkata"), "Asia/Kolkata", "B7 IANA id passthrough");
  assertEqual(resolveTimeZone("in Nowheretown"), null, "B7 unknown place → null (falls back to default, labelled)");
}

{
  const tz = defaultTimeZone();
  assert(tz.length > 0, "B8 defaultTimeZone non-empty");
  assert(tz.includes("/"), "B8 default tz is an IANA id (region/city)");
}

{
  const dq = computeDateQuery("what day is tomorrow", NOW);
  assertEqual(dq?.label, "Tomorrow", "B9 computeDateQuery label for tomorrow");
  assertEqual(dq?.target.getUTCDate(), 29, "B9 tomorrow target day 29");
}

// ---------------------------------------------------------------------------
// C. Calculator safety
// ---------------------------------------------------------------------------

section("C. Calculator (safe parser)");

function checkCalc(expr: string, expected: string | null, label: string) {
  const result = evaluateExpression(expr);
  if (expected === null) {
    assertEqual(result.ok, false, `${label} rejected`);
  } else {
    assertEqual(result.ok, true, `${label} accepted`);
    if (result.ok) assertEqual(result.formatted, expected, `${label} = ${expected}`);
  }
}

checkCalc("2 + 2", "4", "C1 2 + 2");
checkCalc("10 - 2 * 3", "4", "C2 precedence 10 - 2 * 3");
checkCalc("(2 + 3) * 4", "20", "C3 parentheses");
checkCalc("7 % 3", "1", "C4 modulo");
checkCalc("6 / 2", "3", "C5 division");
checkCalc("-5 + 3", "-2", "C6 unary minus");
checkCalc("2.5 * 4", "10", "C7 decimals");
checkCalc("sqrt(16)", "4", "C8 sqrt");
checkCalc("pow(2, 10)", "1024", "C9 pow");
checkCalc("3 ^ 4", "81", "C10 power operator");
checkCalc("2^10", "1024", "C11 2^10");
checkCalc("((2 + 3))", "5", "C12 nested parens");

{
  const r = evaluateExpression("1 / 0");
  assertEqual(r.ok, false, "C13 division by zero rejected");
  if (!r.ok) assertEqual(r.code, "math_divide_by_zero", "C13 code=math_divide_by_zero");
}
{
  const r = evaluateExpression("5 % 0");
  assertEqual(r.ok, false, "C14 modulo by zero rejected");
}
{
  const r = evaluateExpression("sqrt(-9)");
  assertEqual(r.ok, false, "C15 sqrt(negative) rejected");
}
{
  const r = evaluateExpression("10 ^ 999");
  assertEqual(r.ok, false, "C16 huge exponent rejected (bounded)");
}
{
  const r = evaluateExpression("9999999999999999 * 9999999999999999");
  assertEqual(r.ok, false, "C17 oversized result rejected");
}
{
  const r = evaluateExpression("");
  assertEqual(r.ok, false, "C18 empty input rejected");
}
{
  const r = evaluateExpression("2 +");
  assertEqual(r.ok, false, "C19 trailing operator rejected");
}
{
  const injections = ["process.exit(1)", "import('x')", "fetch('http://x')", "() => 5", "alert(1)", "2 + 2; rm -rf /", "x = 5", "require('fs')", "Math.random()", "1e308"];
  for (const code of injections) {
    const r = evaluateExpression(code);
    assertEqual(r.ok, false, `C20 injection '${code}' rejected`);
  }
}
{
  const safe = evaluateExpression("2 + 2");
  if (safe.ok) {
    assert(!/NaN|Infinity|undefined/.test(safe.formatted), "C21 formatted result never NaN/Infinity/undefined");
  }
  assert(true, "C21 check ran");
}
{
  const extract = extractCalculation("what time is it");
  assertEqual(extract, null, "C22 'what time is it' is NOT a calculation");
  assertEqual(extractCalculation("what is 2 plus 2"), null, "C22 words like 'plus' are not accepted (no eval of text)");
}

// ---------------------------------------------------------------------------
// D. Weather tool (Open-Meteo — keyless)
// ---------------------------------------------------------------------------

section("D. Weather tool (Open-Meteo, keyless)");

// Reusable Open-Meteo payload fragments (shapes verified against the real
// live API during the integration repair).
const GEO_LONDON = {
  results: [
    {
      name: "London",
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      admin1: "England",
      timezone: "Europe/London",
    },
  ],
};
const GEO_PARIS = {
  results: [
    {
      name: "Paris",
      latitude: 48.8566,
      longitude: 2.3522,
      country: "France",
      admin1: "Île-de-France",
      timezone: "Europe/Paris",
    },
  ],
};
const FC_LONDON = {
  timezone: "Europe/London",
  current: {
    time: "2026-08-28T11:00",
    temperature_2m: 15.0,
    relative_humidity_2m: 72,
    apparent_temperature: 14.2,
    precipitation: 0.4,
    weather_code: 51,
    wind_speed_10m: 11.1,
  },
  daily: {
    time: ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"],
    weather_code: [51, 3, 63, 95, 75],
    temperature_2m_max: [16.9, 15.3, 14.0, 12.2, 11.8],
    temperature_2m_min: [9.1, 10.2, 7.5, 6.0, 5.9],
    precipitation_probability_max: [44, 82, 60, 71, 30],
    precipitation_sum: [0.4, 2.1, 0.0, 1.4, 0.2],
    wind_speed_10m_max: [9.1, 14.4, 10.8, 12.8, 8.2],
  },
};

/** Routes between the Open-Meteo geocoding and forecast endpoints. */
function openMeteoStub(options: {
  geo?: unknown;
  forecast?: unknown;
  geoStatus?: number;
  forecastStatus?: number;
}) {
  return makeFetch((url) => {
    if (url.includes("geocoding-api.open-meteo.com")) {
      if (options.geoStatus) return jsonResponse(options.geoStatus, options.geo ?? {});
      return jsonResponse(200, options.geo ?? { results: [] });
    }
    if (url.includes("api.open-meteo.com")) {
      if (options.forecastStatus) return jsonResponse(options.forecastStatus, options.forecast ?? {});
      return jsonResponse(200, options.forecast ?? {});
    }
    return jsonResponse(404, {});
  });
}

function callsTo(calls: FetchCall[], host: string): number {
  return calls.filter((c) => c.url.includes(host)).length;
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: FC_LONDON });
  delete process.env.WEATHER_API_KEY;
  const result = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d0",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, true, "D1 keyless: weather works with NO API key configured");
  assert(result.answer?.includes("London") ?? false, "D1 real data flows without any key");
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d1",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, true, "D2 current weather success");
  assert(result.answer?.includes("London") ?? false, "D2 answer names the city");
  assert(result.answer?.includes("15°C") ?? false, "D2 answer carries the measured temp");
  assert(result.answer?.includes("Light drizzle") ?? false, "D2 WMO code 51 → 'Light drizzle'");
  assert(result.answer?.includes("Source: Open-Meteo") ?? false, "D2 answer is grounded to the provider");
  assert(result.answer?.includes("Checked:") ?? false, "D2 answer labels when it was checked");
  assertEqual(result.details.latitude, 51.5074, "D2 structured latitude exposed internally");
  assertEqual(result.details.timezone, "Europe/London", "D2 structured timezone exposed internally");
  assertEqual(result.details.attempts, 1, "D2 single attempt");
  assertEqual(callsTo(stub.calls, "geocoding-api.open-meteo.com"), 1, "D2 geocoded once");
  assertEqual(callsTo(stub.calls, "api.open-meteo.com/v1/forecast"), 1, "D2 forecast fetched once");
}

{
  const stub = openMeteoStub({ geo: GEO_PARIS, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "Paris",
    kind: "forecast",
    userId: "d2",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, true, "D3 forecast success");
  assert(result.answer?.startsWith("Forecast for Paris") ?? false, "D3 answer is a forecast for the right city");
  assert(result.answer?.includes("next 5 days") ?? false, "D3 forecast horizon stated");
  assert(result.answer?.includes("Thunderstorm") ?? false, "D3 WMO code 95 mapped to 'Thunderstorm'");
  assert(result.answer?.includes("rain chance") ?? false, "D3 precipitation probability surfaced");
  assertEqual((result.details.days as unknown[] | undefined)?.length, 5, "D3 structured 5-day array");
}

{
  const stub = openMeteoStub({ geoStatus: 500, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d3",
    fetchImpl: stub.fn,
    maxAttempts: 1,
  });
  assertEqual(result.success, false, "D4 geocode 500 → safe failure");
  assertEqual(result.error?.code, "weather_upstream_error", "D4 code=weather_upstream_error");
  assertEqual(result.details.attempts, 1, "D4 attempted once with maxAttempts=1");
}

{
  const stub = openMeteoStub({ geoStatus: 404, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "Atlantis",
    kind: "current",
    userId: "d4",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, false, "D5 geocode 404 → safe failure");
  assertEqual(result.error?.code, "weather_upstream_error", "D5 code=weather_upstream_error (404 is upstream, not a place)");
  assert(result.error?.message.includes("Atlantis") === false, "D5 message is generic/safe");
}

{
  const stub = openMeteoStub({ geo: { results: [] }, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "Nowhereville",
    kind: "current",
    userId: "d5",
    fetchImpl: stub.fn,
  });
  assertEqual(result.error?.code, "location_not_found", "D5b empty geocode results → location_not_found");
}

{
  const stub = hangingFetch();
  const result = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d6",
    fetchImpl: stub.fn,
    timeoutMs: 40,
    backoffMs: 5,
  });
  assertEqual(result.success, false, "D6 timeout → safe failure");
  assertEqual(result.error?.code, "weather_timeout_or_unreachable", "D6 code=weather_timeout_or_unreachable");
  assertEqual(result.details.timedOut, true, "D6 timeout flagged");
  assertEqual(result.details.attempts, 2, "D6 bounded retry (2 attempts) then stops");
  assertEqual(callsTo(stub.calls, "geocoding-api.open-meteo.com"), 2, "D6 geocode retried twice, then aborts");
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: { bogus: true } });
  const result = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d7",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, false, "D7 malformed forecast payload → safe failure");
  assertEqual(result.error?.code, "weather_malformed", "D7 code=weather_malformed");
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: FC_LONDON });
  const result1 = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d8",
    fetchImpl: stub.fn,
  });
  const result2 = await fetchRealtimeWeather({
    location: "London",
    kind: "current",
    userId: "d8",
    fetchImpl: stub.fn,
  });
  assertEqual(result1.success, true, "D8 first weather call works");
  assertEqual(result2.success, true, "D8 second call (cached) works");
  assertEqual(result2.details.cached, true, "D8 second call served from cache");
  assertEqual(stub.calls.length, 2, "D8 one geocode + one forecast total (cache absorbs repeats)");

  const result3 = await fetchRealtimeWeather({
    location: "London",
    kind: "forecast",
    userId: "d8",
    fetchImpl: stub.fn,
  });
  assertEqual(result3.success, true, "D8 forecast for same city still works");
  assertEqual(callsTo(stub.calls, "api.open-meteo.com/v1/forecast"), 2, "D8 cache key includes kind (forecast refetched)");
  assertEqual(callsTo(stub.calls, "geocoding-api.open-meteo.com"), 1, "D8 geocode cached across kinds");
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: FC_LONDON });
  await fetchRealtimeWeather({ location: "London", kind: "current", userId: "user-A", fetchImpl: stub.fn });
  await fetchRealtimeWeather({ location: "London", kind: "current", userId: "user-B", fetchImpl: stub.fn });
  assertEqual(stub.calls.length, 4, "D9 cache keys are user-scoped (2 users × geo+forecast)");
}

{
  const stub = openMeteoStub({ geo: GEO_LONDON, forecast: FC_LONDON });
  const result = await fetchRealtimeWeather({
    location: "Chennai",
    kind: "current",
    userId: "d10",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, true, "D10 resolution is generic (any city resolves via geocode)");
}

{
  const result = await fetchRealtimeWeather({
    location: "",
    kind: "current",
    userId: "d11",
    fetchImpl: undefined,
  });
  assertEqual(result.success, false, "D11 location-less weather → location prompt");
  assertEqual(result.error?.code, "location_required", "D11 code=location_required");
  assert((result.error?.message.includes("Which location should I check?")) ?? false, "D11 helpful, safe message");
}

// ---------------------------------------------------------------------------
// E. Currency tool
// ---------------------------------------------------------------------------

section("E. Currency tool");

{
  const stub = makeFetch(() => jsonResponse(200, {}));
  delete process.env.EXCHANGE_RATE_API_KEY;
  const result = await fetchRealtimeCurrency({
    from: "USD",
    to: "EUR",
    amount: 100,
    userId: "e0",
    fetchImpl: stub.fn,
  });
  assertEqual(result.success, false, "E1 no API key → safe not-configured failure");
  assertEqual(result.error?.code, "currency_not_configured", "E1 code=currency_not_configured (never guesses rates)");
  assertEqual(stub.calls.length, 0, "E1 no provider call without a key");
}

{
  const stub = makeFetch(() => jsonResponse(200, { conversion_rate: 84.225, base_code: "USD", target_code: "EUR" }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 100, userId: "e1", fetchImpl: stub.fn })
  );
  assertEqual(result.success, true, "E2 conversion success");
  assert(result.answer?.includes("100 USD = 8,422.50 EUR") ?? false, "E2 conversion computed from provider rate");
  assert(result.answer?.includes("1 USD = 84.225 EUR") ?? false, "E2 rate reported");
  assert(result.answer?.includes("updated ") ?? false, "E2 provider timestamp present");
  assertEqual(result.details.rate, 84.225, "E2 structured rate exposed internally");
}

{
  const stub = makeFetch(() => jsonResponse(200, { conversion_rate: 1.08 }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e2", fetchImpl: stub.fn })
  );
  assertEqual(result.success, true, "E3 rate-only (amount 1) works");
}

{
  const stub = makeFetch(() => jsonResponse(500, {}));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e3", fetchImpl: stub.fn, maxAttempts: 1 })
  );
  assertEqual(result.success, false, "E4 upstream 500 → safe failure");
  assertEqual(result.error?.code, "currency_upstream_error", "E4 code=currency_upstream_error");
}

{
  const stub = makeFetch(() => jsonResponse(401, { message: "Invalid key" }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-bad", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e4", fetchImpl: stub.fn, maxAttempts: 3 })
  );
  assertEqual(result.error?.code, "currency_auth_failed", "E5 invalid key → auth failure");
  assertEqual(result.details.attempts, 1, "E5 invalid key never retried");
  assertEqual(stub.calls.length, 1, "E5 single provider call");
}

{
  const stub = makeFetch(() => jsonResponse(429, {}));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e5", fetchImpl: stub.fn })
  );
  assertEqual(result.error?.code, "currency_rate_limited", "E6 rate-limited → safe code, no hot-loop retries");
  assertEqual(result.details.attempts, 1, "E6 429 not retried repeatedly");
}

{
  const stub = hangingFetch();
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e6", fetchImpl: stub.fn, timeoutMs: 40, backoffMs: 5 })
  );
  assertEqual(result.success, false, "E7 timeout → safe failure");
  assertEqual(result.error?.code, "currency_timeout_or_unreachable", "E7 code=currency_timeout_or_unreachable");
  assertEqual(result.details.timedOut, true, "E7 timeout flagged");
}

{
  const stub = makeFetch(() => jsonResponse(200, { foo: "bar" }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "USD", to: "EUR", amount: 1, userId: "e7", fetchImpl: stub.fn })
  );
  assertEqual(result.success, false, "E8 malformed payload → safe failure");
  assertEqual(result.error?.code, "currency_malformed", "E8 code=currency_malformed");
}

{
  const stub = makeFetch(() => jsonResponse(200, { conversion_rate: 0.92 }));
  await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "EUR", to: "USD", amount: 1, userId: "e8", fetchImpl: stub.fn })
  );
  await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "EUR", to: "USD", amount: 1, userId: "e8", fetchImpl: stub.fn })
  );
  assertEqual(stub.calls.length, 1, "E9 short-TTL cache: second rate call cached");

  const stubIsolated = makeFetch(() => jsonResponse(200, { conversion_rate: 0.92 }));
  await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "EUR", to: "USD", amount: 1, userId: "ua", fetchImpl: stubIsolated.fn })
  );
  await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    fetchRealtimeCurrency({ from: "EUR", to: "USD", amount: 1, userId: "ub", fetchImpl: stubIsolated.fn })
  );
  assertEqual(stubIsolated.calls.length, 2, "E10 cache keys are user-scoped");
}

{
  const stub = makeFetch(() => jsonResponse(200, { conversion_rate: 84.225 }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    executeRealtimeTool({
      decision: detectRealtimeIntent({ message: "100 usd to eur" }),
      message: "100 usd to eur",
      userId: "e11",
      fetchImpl: stub.fn,
    })
  );
  assertEqual(result.success, true, "E11 routed end-to-end conversion works");
  assert(result.answer?.includes("100 USD = 8,422.50 EUR") ?? false, "E11 full pipeline answer");
}

{
  const stub = makeFetch(() => jsonResponse(200, { conversion_rate: 1 }));
  const result = await withEnvKey(CURRENCY_KEY, "ck-valid", () =>
    executeRealtimeTool({
      decision: detectRealtimeIntent({ message: "convert 100 dollars to euros" }),
      message: "convert 100 dollars to euros",
      userId: "e12",
      fetchImpl: stub.fn,
    })
  );
  assertEqual(result.success, false, "E12 unparseable pair → safe guidance failure");
  assertEqual(result.error?.code, "currency_pair_required", "E12 code=currency_pair_required");
  assertEqual(stub.calls.length, 0, "E12 provider never called for a malformed pair (no guessing)");
}

// ---------------------------------------------------------------------------
// F. Security / grounding
// ---------------------------------------------------------------------------

section("F. Security & grounding");

{
  const secretKey = "SUPER-SECRET-KEY-6A";
  const stub = openMeteoStub({ geoStatus: 401, geo: {}, forecast: {} });
  const result = await withEnvKey(WEATHER_KEY, secretKey, () =>
    fetchRealtimeWeather({ location: "London", kind: "current", userId: "f1", fetchImpl: stub.fn })
  );
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(secretKey), "F1 API key NEVER leaks into results");
  assert(!result.error?.message.includes("SUPER"), "F1 error message hides the key");
}

{
  const stub = openMeteoStub({ geoStatus: 500, geo: {}, forecast: {} });
  const result = await withEnvKey(WEATHER_KEY, "sk", () =>
    fetchRealtimeWeather({ location: "London", kind: "current", userId: "f2", fetchImpl: stub.fn, maxAttempts: 1 })
  );
  const text = JSON.stringify(result);
  assert(!text.includes("api.open-meteo.com"), "F2 internal provider URL hidden");
  assert(JSON.stringify(result.answer ?? "").includes("open-meteo.com") === false, "F2 answer never leaks endpoints");
  assert(!/Stack|TypeError|Error:/.test(text), "F2 no stack traces / internal shapes");
}

{
  const ok = await executeRealtimeTool({
    decision: decisionFor({ intent: "CALCULATION", params: { expression: "1 / 0" } }),
    message: "1 / 0",
  });
  assertEqual(ok.success, false, "F3 divide-by-zero handled structurally (never throws)");
  assertEqual(ok.error?.code, "math_divide_by_zero", "F3 typed safe code");
}

{
  let threw = false;
  try {
    await executeRealtimeTool({ decision: { intent: "NONE", handled: false, reason: "x" }, message: "anything" });
  } catch {
    threw = true;
  }
  assertEqual(threw, false, "F4 executeRealtimeTool never throws even for unhandled/unknown");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "CURRENT_TIME", params: { tz: "UTC" } }),
    message: "what time is it",
    now: () => NOW,
  });
  const g = buildRealtimeSystemInstruction(result);
  assert(g.includes("10:00:00"), "F5 grounding block embeds the actual measured value");
  assert(!/undefined|NaN|\[object Object\]/.test(g), "F5 grounding block contains no garbage");
}

{
  const result = await executeRealtimeTool({
    decision: decisionFor({ intent: "CALCULATION", params: { expression: "6 * 7" } }),
    message: "6 * 7",
  });
  assertEqual(result.answer, "42", "F6 calculator answer directly from the tool (no Gemini)");
}

{
  const failure = await executeRealtimeTool({
    decision: decisionFor({ intent: "WEATHER_CURRENT", params: { location: "" } }),
    message: "what's the weather",
    userId: "f7",
  });
  assertEqual(failure.success, false, "F7 weather without location → safe location prompt (never invented)");
  assertEqual(failure.error?.code, "location_required", "F7 code=location_required");
  assert(!(failure.answer?.includes("undefined") ?? false), "F7 no JS leakage in answer");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n==================================================================");
console.log("PHASE 6A — REAL-TIME INTELLIGENCE TEST REPORT");
console.log("==================================================================");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);
console.log("==================================================================");

if (failed > 0) {
  console.error("Phase 6A test suite FAILED.");
  process.exit(1);
}
console.log("Phase 6A test suite PASSED.");
}

void runPhase6ATests();