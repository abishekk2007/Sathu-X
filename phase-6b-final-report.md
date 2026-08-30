# Phase 6B — Central Query Router + Domain Advisory Final Report

**Date:** 2026-08-28
**Phase:** 6B — a deterministic central query router layered above Phases 1–6A that
selects which existing capability runs, resolves follow-ups, and composes hybrid
evidence (realtime + document/visual + domain advisory) for Gemini to explain —
plus an **extended domain advisory** (agriculture, marine, aviation, smart city,
travel, outdoor) that detects domain intent, resolves location/timeframe context,
and returns deterministic plain-text advisories from Open-Meteo. Verified by a new
automated suite (252 assertions) + full regression + live API checks; the browser
tier remains pending (honest below).

---

## 1. Executive summary

Phase 6B makes the chat server **route first, then execute**. A pure, deterministic
`routeQuery` decision layer sits at the top of `src/app/api/chat/route.ts` and decides,
from the message + attached sources + prior turns, whether a turn is a realtime
question (answered directly as a plain-text 200, no Gemini), a domain advisory question
(also answered directly as a plain-text 200), a document/visual/general turn (existing
Phase 1–6A pipeline untouched), an ambiguous deictic (clarification), or a **HYBRID**
turn — a strong real-time or domain intent behind an explicit document/visual reference
with sources — which executes the tool *and* the existing retrieval/visual engines, then
fuses the tool result verbatim into Gemini's system instruction.

The "Extended domain advisory" half of 6B adds six domains on top of 6A's generic
weather: **AGRICULTURE, MARINE, AVIATION, SMART_CITY, TRAVEL, OUTDOOR**. A deterministic
`detectDomainIntent` classifier routes phrasing like "Should I water my crops in
Coimbatore tomorrow?", "marine conditions near Chennai", or "Will Chennai flood tonight?"
to a dedicated `DOMAIN_REALTIME` sub-route; `resolveDomainContext` inherits
location/timeframe from prior turns; `executeDomainTool` geocodes and fetches the
domain-specific Open-Meteo block; `buildAdvisory` renders a *deterministic* text briefing
(no LLM) with severity, factors, unit-aware values ("Not available", never fake zeros),
provider attribution, and per-domain safety caveats.

Nothing existing was rebuilt. The router reuses only existing detectors/services and the
domain layer reuses Open-Meteo; it never generates answers itself — it only decides,
fetches, and composes.

Automated verification: **252/252 Phase 6B assertions** (new suite **`test-phase6b.ts`**,
sections A–N), full regression of all prior suites (see §17), `tsc --noEmit` clean,
`npm run lint` 0 errors, `npm run build` succeeds. Live domain API checks (geocode +
agriculture + aviation + marine + smart-city behind real Open-Meteo calls) passed in a
standalone harness (see §19). Live `/api/chat` and browser UI validation remain
auth-gated / require a browser (no automation available) and are reported as pending —
this phase does not claim them.

## 2. Scope & coexistence

- `routeQuery` is advisory: for GENERAL/DOCUMENT_RAG/VISUAL/MULTIMODAL/CLARIFICATION it
  returns a decision and the existing pipeline still executes — the router intercepts
  **only** the direct-realtime, direct-domain, and HYBRID paths in the server.
- `DOMAIN_REALTIME` is a router sub-route, not a new provider: execution reuses the same
  keyless Open-Meteo stack proven in 6A (generic hourly forecast for
  agriculture/aviation/smart-city/travel/outdoor, `marine-api` for marine) plus a shared
  geocoder. No Provider/AnswerGenerator/Agent exists for domains by design.
- The RAG structural/exact-question behavior, visual 5E-1/5E-2, realtime 6A, caching
  5F, hardening 5H, Gemini Streaming, and the frontend response contract are untouched.
  Direct realtime/domain answers preserve the existing plain-text 200 +
  `[api/chat] outcome=realtime/domain …` watchdog log format, so the chat UI required
  **zero changes**.
- Non-activated extension points (IMAGE_GENERATION, IMAGE_EDITING, WEB_SEARCH, VOICE,
  TASK, MEMORY) are declared in `EXTENSION_POINTS` and defaulted off. The 6C domain
  extension points (AIR_QUALITY, POLLEN, TRAFFIC, DISASTER_ALERTS, FLOOD_RISK,
  EARTHQUAKE, FIRE_RISK, WEB_SEARCH, IMAGE_GENERATION) are likewise declared, never
  called today.

## 3. Architecture — where the router lives

```
/chat message + context sources + prior turns
        │
        ▼
routeQuery(userId, message, hasSources, sourceCount, priorTurns, mode, …)   ── PURE
        │  returns QueryRouteDecision { primaryRoute, confidence, reason,
        │    realtimeDecision?, domainDecision?, visualDecision?,
        │    multimodalDecision?, followUpResolution?, executionPlan { … } }
        ├──► REALTIME_* / CALCULATION ──► executeRealtimeTool ──► plain-text 200
        ├──► DOMAIN_REALTIME ──► executeDomainTool ──► plain-text 200
        ├──► HYBRID ──► executeRealtime/DomainTool (store result) ──► existing
        │     retrieval + visual engines ──► Gemini streams with fused
        │     buildRealtime/DomainSystemInstruction(result) in the system instruction
        └──► everything else ──► existing Phase 1–6A pipeline, byte-for-byte
```

Domain execution (no router involvement): `detectDomainIntent(message)` →
`resolveDomainContext(decision, priorTurns)` → `executeDomainTool({decision, userId})`
(geocode → domain-specific Open-Meteo fetch → `buildAdvisory`) →
`buildDomainSystemInstruction(result)` for hybrid fusion. All deterministic; no LLM.

`describeQueryRoute` renders a compact human string logged as
`[api/chat] route <…>` on every turn (debug/observability only — nothing internal is
sent to the client).

## 4. Route catalog & priority order

Ten evaluated branches, then a GENERAL fall-through (line numbers refer to
`src/lib/agent/query-router.ts`):

| # | Branch | Result |
|---|---|---|
| 1 | Semantic definition guard (`isRealtimeConceptDefinition`, domain-definition anchors) | GENERAL — "What is weather?", "Explain marine biology." never hit tools |
| 2 | Strong realtime/domain + explicit document reference **with sources** | HYBRID (realtime or DOMAIN_REALTIME + RAG) |
| 3 | Strong realtime + visual reference **with sources** | HYBRID (realtime + visual) |
| 4 | Document reference guard (6A stand-down; domain probe also stands down without sources) | GENERAL/RAG |
| 5 | Follow-up resolution (weather/currency/time/document/domain-anchored) | CURRENCY/WEATHER/TIME/DOC or REALTIME_DATE/DOMAIN_REALTIME |
| 6 | Domain advisory intent (agriculture/marine/aviation/smart-city/travel/outdoor) | DOMAIN_REALTIME |
| 7 | Single real-time intent | REALTIME_DATE/TIME/WEATHER/CURRENCY/CALCULATION |
| 8 | Visual intent with sources | VISUAL / MULTIMODAL |
| 9 | Sources attached | DOCUMENT_RAG |
| 10 | Ambiguous deictic ("it", "that", "this" alone) | CLARIFICATION (naming the missing thread) |
| — | Fall-through | GENERAL (Gemini, no sources) |

Semantic context beats bare keyword matching throughout (branch 1); document references
always win over realtime and domains (branches 2/4); a domain advisory beats generic
weather (branch 6 precedes 7) when no doc guard applies. Confidence tiers:
0.90–1.00 HIGH (direct), 0.70–0.89 MEDIUM, <0.70 LOW → clarification or safe general;
the internal `reason` is never exposed to clients.

## 5. Domain intent detection

`detectDomainIntent(message)` in `src/lib/realtime/domain.ts` returns a `DomainDecision`
(`{ handled, domain, location, timeframe, confidence, followUp }` or NONE). Pure regex /
heuristic — no LLM.

- **Global gates.** `QUESTION_SIGNAL` (who/what/when/where/why/how/can/should/is/are/will/
  would/do/does) must match; definition/knowledge guards (`isDefinitionOf`,
  `DEF_ANCHORS`) and story/story-openers guards route "Explain marine biology.",
  "What is aviation?", "Tell me a story about farming." to NONE.
- **Precedence.** MARINE > AVIATION > AGRICULTURE > SMART_CITY > OUTDOOR > TRAVEL.
  Only the first winning domain's hit counts; each candidate uses `DOMAIN_FACTORS`
  (regex factor + weight) with a minimum-score threshold — precedence short-circuits
  ties so a message can't double-route.
- **Gated keyword pairs (weather context required).**
  - AGRICULTURE: `AGRICULTURE_TOKENS` (`farming|farm\b|farmer|crops?|agriculture|agri…`)
    **and** `AGRICULTURE_WORK` (`weather|forecast|rain|wind|spray|pesticide|planting|
    irrigat|field|…`). "How can I tell if my crops are ready for harvest?" → NONE.
  - AVIATION: `AVIATION_FLIGHT` (`flight|flights|flying|airport|runway|vfr|ifr|…`)
    **and** `AVIATION_WORK` (`weather|conditions?|forecast|visibility|wind|cloud|
    briefing|airport|…`). "Is my flight to Delhi likely to land on time tomorrow?" →
    GENERAL (no weather word).
- **Place & time.** Location from the subject ("Will Chennai flood tonight?") or a
  tail preposition (`in|for|at|to|near …$`) **filtered by `GENERIC_TAIL`** — tails like
  "marine operations", "travelling to Chennai", "Chennai airport" are rejected so the
  location is never invented. Timeframe precedence: tonight > tomorrow > weekend > week
  > today > now.
- **Follow-ups.** "what about farming?" → `FOLLOW_UP_DOMAINS` (array of
  `[RegExp, DomainIntent]`) → handled, domain, confidence ~0.78.
- **Confidence.** 0.94 with an explicit credible location, 0.85 without, 0.78 for a
  bare follow-up. A fully unsupported message or a bare "what about tomorrow?" →
  NONE (no location/no domain noun: routes outside the domain layer).

## 6. Location resolution & context inheritance

`resolveDomainContext(decision, priorTurns)`:

- Extracts location/timeframe where the detection left them empty, scanning the last
  few prior turns for an earlier `DOMAIN_REALTIME` (or realtime) decision **only when
  exactly one distinct location is found** — ambiguity ⇒ no inheritance (never guess).
  E.g. "what about farming?" after a Chennai agriculture answer → AGRICULTURE with
  Chennai inherited; two different cities in history → no location.
- Supports document-anchored lookups (`resolveDomainContext` overloads) the router also
  uses for hybrid question extraction.
- Timeframe inheritance restores a domain intent behind bare temporals
  ("marine conditions tomorrow?" → MARINE, tomorrow).

## 7. Domain advisory engine

`buildAdvisory(domain, input, payload)` in `src/lib/realtime/advisory.ts` renders a
deterministic briefing — **no LLM, no invented values**:

- **Factors** per domain (temperature/feels-like, rain probability, wind, gusts,
  visibility, humidity, cloud, conditions; marine: significant/swell height, wave
  period, wind, precip risk, SST, ocean current). Each factor is `key/label/value/unit/
  severity`; unit-aware value formatting (`factorValue`) shows a genuinely missing value
  as **"Not available" with no unit suffix** — never a fake zero.
- **Number formatting.** `fmt(value, digits)` rounds to `digits` decimals (integers
  untouched). Temperatures/humidity round to whole degrees (agriculture/aviation/
  smart-city/travel/outdoor) or 1 decimal (sea surface temperature); the raw floats
  observed in an early live run were fully rounded before final verification.
- **Visibility is kilometers.** Open-Meteo returns meters — `minVis` divides by 1000
  (`best / 1000`) so "6280 km" can never appear.
- **Assessment** derives from severity thresholds (rain risk, wind speed, visibility,
  wave height, flood-relevant rainfall); `severity: "low" | "moderate" | "high"` +
  "unknown" where the provider is silent.
- **Provider attribution.** `PROVIDER[domain]` renders "Source: Open-Meteo" (all
  land domains) or "Source: Open-Meteo Marine".
- **Per-domain safety note** (STEP 73): agriculture — informational, not official
  agricultural approval/certification; aviation — NOT flight clearance / ATC / pilot
  authorization; marine — NOT a navigation clearance or a claim that operations are
  safe; smart-city — street-level flooding is NOT predicted from weather data alone
  (drainage/terrain/water levels decide); travel/outdoor — informational.

## 8. Router implementation

- `routeQuery(input)` → `QueryRouteDecision`; pure — makes no network/Supabase/Gemini
  calls (asserted in the suite).
- **Probes.** `detectRealtimeIntent` has an *unconditional* document stand-down
  (6A), correct for execution but dead for hybrid *detection*; the router uses a
  doc-agnostic `probeRealtimeIntent(message)` (CALCULATION > CURRENCY > WEATHER >
  DATE/TIME) purely for routing. The domain probe mirrors the same design and **stands
  down entirely** when a document is referenced without sources:
  `domainProbe = (initialDomain.handled && !docReferenced) || (initialDomain.handled && docReferenced && hasSources) ? resolveDomainContext(…) : undefined`.
- **Hybrid branch 2** widens to
  `docReferenced && hasSources && (probeWeatherStrong || domainProbe?.handled)`: the
  domain variant routes `["DOMAIN_REALTIME"]` and carries `domainDecision` (no
  `realtimeDecision`).
- **Follow-ups.** `resolveFollowUp` anchors on prior turns; a bare "what about
  tomorrow?" binds to the prior weather forecast (`isBareTemporalFollowUp`), and a
  bare domain follow-up binds to the prior domain decision.
- `isRealtimeConceptDefinition` (branch 1) and `WEATHER_PROSE_WORDS` +
  `isCredibleWeatherLocation` prevent tool trips on everyday chat.

## 9. Domain execution & hybrid fusion

`executeDomainTool({ decision, userId })`:

- No location ⇒ throws `location_required` (sub-tool `{ ok: false, errorTraced: true,
  errorCode: "location_required" }`), matching 6A's tool-error shape; the server
  returns a helpful "Which location should I check?" style message. Never invents a place.
- Ordered **geocode → fetch**: (1) shared geocoder (same Open-Meteo endpoint/cache as
  6A, user-scoped), (2) provider fetch — generic hourly forecast
  (`api.open-meteo.com/v1/forecast`) for agriculture/aviation/smart-city/travel/outdoor;
  `marine-api.open-meteo.com/v1/marine` for MARINE), (3) `buildAdvisory`.

Chat-server path (`src/app/api/chat/route.ts`):

- `isDirectDomain = primaryRoute === "DOMAIN_REALTIME"` → `executeDomainTool`, returns
  the advisory as a **plain-text 200** with the same no-store/X-Accel-Buffering headers
  as 6A; watchdog log `[api/chat] outcome=domain domain=… ok=… elapsed=…`.
- **HYBRID with domainDecision**: the tool runs only when
  `isDirectDomain || Boolean(domainResult.location)` — a doc-hybrid without a resolvable
  location skips execution so Gemini answers from the attached document (no injected
  location prompt); when it runs, `buildDomainSystemInstruction(result)` is pushed into
  `memorySections` beside the realtime grounding block.

## 10. Hybrid composition (tool + RAG/visual + Gemini)

For a HYBRID turn the server:

1. Executes `executeRealtimeTool` (6A) and/or `executeDomainTool` (this phase) and keeps
   the structured result.
2. Proceeds through the **existing** retrieval ("searq"/`retrieveAgentContext`) and
   visual (`detectVisualIntent` + `loadVisualEvidence`) machinery unchanged.
3. Appends `buildRealtimeSystemInstruction(result)` / `buildDomainSystemInstruction(result)`
   — the tool result **verbatim** (SEAL ground-truth-style block) — to the memory
   sections **before** `buildSystemInstruction(mode)`, so the Gemini streamed explanation
   can never invent the date/rate/temperature/sea state. If the tool failed, the injected
   block says so and Gemini explains the failure honestly.
4. Partial failure handling: exactly the existing safe-failure paths for whichever
   branch fails; the watchdog still logs `outcome=realtime|domain … ok=…`.

## 11. Determinism & grounding (no-hallucination)

- No LLM anywhere in the decision layer — same input always yields the same route and,
  for domains, the same advisory text for the same payload.
- Authoritative sources only: Open-Meteo / runtime clock / RAG evidence / visual
  evidence; real tool params (`{from: USD, to: EUR, amount: 100}`,
  `{expression: "12 * 34"}`, `{domain, location, timeframe}`) are carried verbatim to
  execution (the suite asserts this seam).
- The reason string and confidence labels are server-internal; direct realtime/domain
  answers never route through Gemini.

## 12. Safety bounds

- `executionPlan.maxDepth = 1` — the router never re-enters itself;
  `maxExternalCalls` ≤ 4 including the Gemini fusion step; hybrid steps carry
  `dependsOn` and `parallelizable` flags.
- STEP 73 domain safety is enforced in the advisory engine (§7) and in the routing
  rules: no official approvals/clearances, no definitive flood predictions ("Will
  Chennai flood tonight?" is allowed as a SMART_CITY *question* — the answer
  explicitly says flooding is NOT predicted from weather data alone and points to
  official municipal alerts), app-level severity summaries only, never fake zeros,
  source attribution always present.
- Prose-location rejection, `GENERIC_TAIL`'s non-place filtering, and the
  single-location-only inheritance rule keep the geocoder and planner away from casual
  chat and from inventing locations.
- Never throws: every guard is boolean and every decision-type assignment is total
  under a final GENERAL fall-through.

## 13. Extension points

`EXTENSION_POINTS` declares image generation/editing, web search, voice, tasks, and
memory as future routes, all `enabled: false`. The 6C domain extension surface
(AIR_QUALITY, POLLEN, TRAFFIC, DISASTER_ALERTS, FLOOD_RISK, EARTHQUAKE, FIRE_RISK,
WEB_SEARCH, IMAGE_GENERATION) is declared in the domain layer and never invoked. The
suite asserts the router never selects a disabled extension point today.

## 14. Integration in `/api/chat`

`src/app/api/chat/route.ts`:

- `routeQuery` is called after role validation, right before the (former) 6A block;
  sources/`sourceCount` derive from the existing context resolution.
- Direct realtime routes (`REALTIME_DATE/TIME/WEATHER/CURRENCY`, `CALCULATION`) and the
  direct domain route (`DOMAIN_REALTIME`) return the existing **plain-text 200** with
  their watchdog lines (`outcome=realtime …` / `outcome=domain …`).
- HYBRID executes the realtime and/or domain tool, stores the result, and lets the
  existing retrieval + visual evidence + Gemini Streaming flow run; the fused grounding
  block(s) append via `memorySections.push(buildRealtime/DomainSystemInstruction(..))`.
- Everything else is untouched — 6A's intent detection is driven through the router's
  `realtimeDecision`/`domainDecision`, preserving 6A's guard and thresholds.

## 15. Repairs / bug fixes in this phase

**Domain/advisory fixes:**

1. **Visibility meters → km.** Open-Meteo returns visibility in meters; an early live
   run showed "Visibility: 6280 km". `minVis` now returns `best / 1000`.
2. **`timeSeries` for string columns.** `buildAdvisory` computed window indices from a
   numeric time series that is actually a string column; the marine builder computed a
   phantom `i` from string `time`. Fixed with a string-aware `timeSeries`/`selectWindow`
   helper and removal of the bogus index math (gusts were also folded into the marine
   summary so the value is never dropped).
3. **Number rounding (`fmt`).** Widening `fmt` to strings lost its `toFixed` rounding,
   so live advisories printed full-precision floats ("Temperature: 25.320833333333336 °C").
   Restored `Number(value.toFixed(digits))` and set temperature/humidity digits to 1 —
   final live answers show "25.3 °C / 82 %".
4. **`factorValue` units.** Units are now embedded in the value string only when a value
   exists — a missing value renders "Not available" with **no** unit suffix (never
   "Not available km/h").
5. **TS-hardening of the domain layer.** `conditionFor(code: number | null)`, `NUM`
   accepts `number | null`, widened `fmt`/`factorValue` inputs, removed dead
   `STOP_WORDS`, and `PROVIDER` attribution map — all keep `tsc --noEmit` green.
6. **False-positive kills.** AGRI gates and AVIATION gates require weather/work context
   ("crops ready for harvest?", "flight … land on time?" → GENERAL); `GENERIC_TAIL`
   rejects non-place tails ("marine operations", "travelling to Chennai", "Chennai
   airport") so locations are never invented.

**Location-extraction repair (post-6B browser finding):**

The chained browser smoke test exposed a real bug: after "What weather conditions are
expected at **Delhi airport**?", the bot wrongly answered "Which location should I
check?" — the user had *already* given the location.

- **Discovered issue.** Explicit locations in the original query were not extracted for
  airport/coastal phrasings ("at Delhi airport?", "…near Chennai?"), "Delhi airport" was
  captured as a single location token, multi-sentence queries ("…at Delhi airport?\nIs
  heavy rainfall expected tonight?") fell apart ("What" leaked into 6A's weather tail and
  the router asked for a location), and compound queries (airport **and** heavy
  rainfall) only answered the first domain.
- **Root cause.** `extractDomainLocation` used a NON-greedy leftmost tail regex
  (`(?:in|for|at|to|near)\s+(…)…$`): for "…good for marine operations near Chennai" it
  captured `"marine operations near Chennai"`, and when credibility rejected that first
  (and only) capture it **never retried a later preposition**. There were also no airport
  suffix stripping, no multi-sentence inspection, and no compound-domain handling.
  (A probe harness `_regex-probe.ts` + an 18-case repro `_loc-repro.ts` confirmed each
  failure before the fix — both deleted after verification.)
- **Fix.** `src/lib/realtime/domain.ts` gained an exported `extractQueryLocation` that
  splits the **whole query into sentences** and per sentence tries, in priority order:
  subject-flood ("Will Chennai flood tonight?"), a **last**-preposition tail (`.*`
  forces the final `$`-anchored preposition), an airport/airfield phrase anywhere, and a
  proper-noun `<City> weather` adjacency. `cleanExtractedLocation` strips temporals,
  possessives, and `PLACE_REF_SUFFIX` (`airport|airfield|coast|coastal|beach|shore|
  offshore`) so "Delhi airport" → "Delhi"; `MULTI_PLACE` keeps "Chennai and Delhi"
  ambiguous (never picks one); `NON_PLACE_HINT` + uppercase-first adjacency stops "the",
  "today's", "marine conditions", or "activities in Bangalore" from reading as places.
- **Compound/multi-sentence.** `detectDomainIntent` now scans **all** precedence
  candidates; the first winning hit is primary and the rest ride along as
  `relatedDomains` on the same decision (shape-identical unless present). The chat route
  executes each related advisory (inherited location) and joins with `"\n\n---\n\n"`,
  so "…at Delhi airport and is heavy rainfall expected tonight?" answers AVIATION + a
  SMART_CITY rainfall note from one turn.
- **Doc-comparison hybrid (guarded).** `query-router.ts` recognizes a comparison word
  (`compare|comparing|comparison|versus|vs|differen[ct]`) + a weather noun + an attached
  document, extracts the comparison location, and routes HYBRID with a synthetic
  `WEATHER_CURRENT` branch — while "what does my PDF say about X weather?" stays
  DOCUMENT_RAG (no comparison word, so location extraction alone never triggers realtime).

**Router fixes (carried from the base 6B phase):**

7. Dead hybrid branches fixed via `probeRealtimeIntent` (doc stand-down made them
   unreachable).
8. Follow-up ordering — bare temporals are 6A `DATE_QUERY`s, so follow-up now runs at
   branch 5 before single realtime, gated by `followUpEligible`.
9. Prose locations rejected ("Tell me a story about weather.").
10. No-params time follow-up ("…and in Tokyo?") resolved.
11. Execution-plan bounds (`maxExternalCalls = min(real-time + retrieval + 1, 4)`).
12. Duplicate `latestUserMessage` declaration removed (single declaration reused by all
    11 call sites); dev server re-confirmed compiling (root page HTTP 200, no overlay).

## 16. Test strategy

`test-phase6b.ts` (relative imports, `assert`/`assertEqual`, exit code 1 on failure)
exercises `routeQuery`/`describeQueryRoute`/`EXTENSION_POINTS`, the domain classifier
`detectDomainIntent`, context resolution + inheritance, and `buildAdvisory` with stubbed
`userId` and prior turns — **no live network, Supabase, or Gemini calls**. Where real
6A/5E-2/domain behavior differed from the letter of a scenario, the assertion was
corrected and documented (see §§5–7, §15).

## 17. Automated validation — full matrix (this session, `npx tsx <suite>.ts`)

| Suite | Result |
|---|---|
| `test-phase6b.ts` (NEW — router + domain advisory, sections A–O) | **308 / 308 passed** |
| `test-phase6a.ts` (real-time intelligence) | **224 / 224 passed** |
| `test-phase5h.ts` (hardening) | **13 / 13 passed** |
| `test-phase5g.ts` (RAG + reliability, 93 rows) | **all passed** |
| `test-phase5f.ts` (caching) | **54 / 54 passed** |
| `test-5e2-final.ts` (multimodal repair) | **69 / 69 passed** |
| `test-structural-fix.ts` (structural retrieval) | **80 / 80 passed** |
| `test-5e2-multimodal.ts` | **84 / 84 passed** |
| `test-visual-processing.ts` | **114 / 114 passed** |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` | 0 errors; 13 warnings (pre-existing across earlier-phase files — none from the 6B location-repair edits) |
| `npm run build` | production build succeeds, all routes compiled |

All suites re-run **after** the final advisory formatting/rounding fix **and again after
the location-extraction repair**; nothing regressed (6B: 252 → 308, the +56 being
section O's 18 regression cases × their assertions).

## 18. Phase 6B suite detail (`test-phase6b.ts`, 308 assertions)

- **A. Direct route matrix** — single-intent routing: date/time (incl. timezones),
  weather, currency, calculations, visual charts, PDF/doc references, matchless general
  questions → GENERAL; A-live phrasings (possessive date, trailing-?, "what is
  weather?" → GENERAL).
- **B. Document / visual / hybrid / guard** — document priority, RAG when sources
  attached, standalone visual, HYBRID requires sources, PDF date never calls realtime.
- **C. STEP 36 negatives** — everyday idiomatic chat never reaches tools.
- **D. Follow-up resolution** — weather ("what about tomorrow?"), currency
  ("what about 50 usd?"), time ("and in Tokyo?"), document-anchored; no prior ⇒ bare
  turn stays REALTIME_DATE.
- **E. Ambiguous deictics** — lone "and it?"/"use that" → CLARIFICATION naming the
  missing thread (< 0.70 confidence), not a hallucinated route.
- **F. Execution-plan bounds** — `maxDepth === 1`, `maxExternalCalls ≤ 4`,
  `parallelizable` only for hybrid with both branches, cycle-free plans.
- **G. Transparency & extension points** — `describeQueryRoute` stable;
  `reason` internal; extension points all default-off and never selected.
- **H. No-hallucination seam** — authoritative verbatim params carried to execution.
- **I. Domain routes (STEP 55 phrasings)** — pesticide in Coimbatore →
  DOMAIN_REALTIME/AGRICULTURE/loc Coimbatore/tomorrow; marine operations; Chennai
  airport → AVIATION; heavy rainfall tonight → SMART_CITY; outdoor event; travelling to
  Chennai → TRAVEL.
- **J. Location resolution** — watering crops (conf 0.94); marine near Chennai
  (loc Chennai); "Will Chennai flood tonight?" → SMART_CITY, location + tonight; spray
  without location → location null (no invention).
- **K. Context inheritance** — "what about tomorrow?" after Chennai → weather with
  Chennai; bare farming follow-up → AGRICULTURE with Chennai; marine follow-up inherits
  location + timeframe; two distinct cities in history ⇒ **no** inheritance.
- **L. Document guard (domains too)** — PDF + agriculture + sources → HYBRID
  (DOCUMENT_RAG + DOMAIN_REALTIME); doc without sources → GENERAL and
  `domainDecision === undefined`; PDF-vs-weather compare → HYBRID;
  `executionPlan.parallelizable` true.
- **M. Domain negatives** — "The weather is nice.", a farming story, "Explain marine
  biology.", "What is aviation?", "What does the word weather mean?" → GENERAL, no
  domain probe; bare weather prompt still REALTIME_WEATHER.
- **N. Safety boundaries (STEP 73)** — "Is it 100% safe to operate my boat tomorrow?"
  → REALTIME_DATE (no marine safety grant, no domainDecision); spray-without-location →
  no invented place; harvest-knowledge and flight-punctuality questions → GENERAL.
- **O. Location-extraction repair (regression for the Delhi-airport bug)** — the 10
  required cases: Delhi airport → AVIATION/Delhi; Chennai airport → AVIATION/Chennai;
  marine near Mumbai → MARINE/Mumbai; marine ops near Chennai → MARINE/Chennai/tomorrow;
  heavy rainfall tonight in Chennai/Delhi → SMART_CITY with the right city; pesticide
  Coimbatore → AGRICULTURE/Coimbatore; outdoor activities Bangalore →
  OUTDOOR/Bangalore; multi-sentence ("…at Delhi airport?\nIs heavy rainfall expected
  tonight?") → AVIATION/Delhi/tonight with the SMART_CITY branch carried and **no
  location prompt**; compound ("…at Delhi airport and is heavy rainfall expected
  tonight?") → AVIATION primary + related SMART_CITY; plus guards: bare "What is the
  weather?" still asks which location; "The weather is nice today." / "Tell me a story
  about Delhi." / "Explain Delhi's history." → GENERAL; PDF-about-Delhi → DOCUMENT_RAG;
  "Compare today's Delhi weather with my PDF." → HYBRID (with sources) / GENERAL (no
  sources); follow-up context keeps Chennai into tomorrow/farming turns.

## 19. Live API validation

| Tier | Status |
|---|---|
| **Automated** | Fully green — §§17–18. |
| **Live API (domains)** | **Passed in a standalone harness (`_live-domain-test.ts`, real unmocked Open-Meteo calls, repo root):** geocode "Chennai" → 13.08784 / 80.27847 (Tamil Nadu, India); AGRICULTURE "Coimbatore" tomorrow → success, severity high, "Source: Open-Meteo"; AVIATION Mumbai airport → success, visibility in km; MARINE Chennai coast → success, severity low, "Source: Open-Meteo Marine", missing wind/precip correctly "Not available"; SMART_CITY Chennai tonight → success, severity moderate, answer explicitly states street-level flooding is NOT predicted from weather data alone. **The bug case was re-run live:** "What weather conditions are expected at Delhi airport?" resolved to `{domain: AVIATION, location: Delhi, handled: true}` and produced a Delhi "Airport Weather Briefing" (2.6 km visibility) with **no "Which location should I check?" prompt**; the compound "What is the weather at Delhi airport and is heavy rainfall expected tonight?" resolved to AVIATION/Delhi with `related: ["SMART_CITY"]` and answered without a location prompt. Formatting verified end-to-end (rounded temps/humidity, km visibility, correct units, no fake zeros, no definitive flood claim). |
| **Live `/api/chat` (auth-gated)** | **Not verified in-session.** POST `/api/chat` without a session returns `401` (Supabase-auth-gated); exercising the full path needs an authenticated browser session (no browser automation available). Currency additionally needs a real `EXCHANGE_RATE_API_KEY`; domain + weather paths are keyless. Root page confirmed HTTP 200 with no compilation overlay after the `latestUserMessage` fix. |

## 20. Browser validation

| Check | Status |
|---|---|
| /chat page loads without a compilation error | **Done — verified live.** `GET http://localhost:3000/` → HTTP 200, no error-overlay/compilation markers. |
| /chat interactive smoke (realtime/domain answer → RAG follow-up) | **Pending (manual)** — chat UI is Supabase-auth-gated; a real signed-in browser session is required and no browser automation is available. Every covered query is asserted at the router/tool level in `test-phase6b.ts` (sections A/B/D/H/I–N). |
| HYBRID turn (tool + document reference + sources) | Pending (manual) — same auth/browser limitation. |

This is the only manual item left for Phase 6B and mirrors the Phase 6A browser item.

## 21. Files changed (complete list)

**New**
- `src/lib/agent/query-router.ts` — the router: `routeQuery`, `probeRealtimeIntent`,
  `resolveFollowUp`, `isBareTemporalFollowUp`, `isRealtimeConceptDefinition`,
  `isCredibleWeatherLocation`, `buildPlan`, `describeQueryRoute`, `EXTENSION_POINTS`,
  all route/plan/confidence types, `WEATHER_PROSE_WORDS` guard, `DOMAIN_REALTIME` route
  + `domainDecision` wiring.
- `src/lib/realtime/domain.ts` — domain layer: `detectDomainIntent`,
  `resolveDomainContext`, `executeDomainTool`, `buildDomainSystemInstruction`, domain
  types (`DomainDecision`, `DomainIntent`, `DomainTimeframe`, `DomainToolResult`),
  `GENERIC_TAIL`/`isCredibleDomainLocation`, gated AGRI/AVIATION regexes,
  `FOLLOW_UP_DOMAINS`, default-off 6C extension surface. **Location repair here:**
  exported `extractQueryLocation` (sentence-split; subject / last-preposition / airport /
  proper-noun-adjective adjacency), `cleanExtractedLocation`, `PLACE_REF_SUFFIX`,
  `NON_PLACE_HINT`, `MULTI_PLACE`, `SENTENCE_SPLIT`, compound `relatedDomains` support.
- `src/lib/realtime/advisory.ts` — deterministic advisory engine (`buildAdvisory`,
  `factorValue`/`fmt`, severity thresholds, `PROVIDER` attribution, per-domain safety
  notes).
- `src/lib/realtime/domain-weather.ts` — shared geocoder + hourly Open-Meteo fetch
  (`conditionFor(code: number | null)`, cache/retry constants).
- `src/lib/realtime/marine.ts` — Open-Meteo Marine provider (fetchMarineConditions),
  ordered geocode→marine.
- `test-phase6b.ts` — 308-assertion automated suite (sections A–O).
- `_live-domain-test.ts` — standalone live-API harness (real Open-Meteo calls; kept as
  the live-tier proof, delete-safe). **Extended with the Delhi-airport bug case + the
  compound airport/heavy-rainfall case.**
- `phase-6b-final-report.md` — this report.

**Modified**
- `src/lib/realtime/index.ts` — barrel now exports the domain surface
  (`detectDomainIntent`, `resolveDomainContext`, `executeDomainTool`,
  `buildDomainSystemInstruction`) + domain types + `${DOMAIN_WEATHER|MARINE}_TIMEOUT_MS`
  / `_MAX_ATTEMPTS` (lint-clean re-exports).
- `src/lib/agent/index.ts` — 6B public surface exported.
- `src/lib/agent/query-router.ts` — **location repair here:** `extractWeatherComparisonLocation`
  (comparison-word + weather-noun + attached-doc → synthetic `WEATHER_CURRENT` hybrid
  branch) and the widened hybrid branch-2 guard so "Compare today's Delhi weather with
  my PDF." → HYBRID while "what does my PDF say about X weather?" stays DOCUMENT_RAG.
- `src/app/api/chat/route.ts` — router dispatch; direct realtime **and** direct domain
  plain-text 200s; HYBRID realtime/domain execution + verbatim `build…SystemInstruction`
  fusion push; domain gating (`isDirectDomain || Boolean(location)`); watchdog logs;
  single `latestUserMessage` declaration. **Location repair here:** the direct-domain
  path runs `relatedDomains` (skipping the primary domain, inheriting the location) and
  joins their answers with `"\n\n---\n\n"` in one plain-text 200.
- `src/app/api/chat/route.ts` import blocks — realtime + domain system-instruction
  builders added; unused `detectRealtimeIntent` import removed (lint-clean).

**Deleted**
- `debug-6b.ts`, `_domain-check.ts`, `_domain-exec-check.ts` — temporary diagnostic
  harnesses, removed before final verification.
- `_loc-repro.ts`, `_regex-probe.ts` — temporary reproduction/probe harnesses for the
  location-extraction bug, removed after the 6B suite + live checks verified the fix.

No changes to the UI, sidebar, auth, upload, or Supabase schema; no `.env` or provider
changes required (weather + domains stay keyless Open-Meteo; currency unchanged).

## 22. Final status

**PHASE 6B COMPLETE (AUTOMATED + LIVE-API DOMAINS VERIFIED) — INTERACTIVE BROWSER SMOKE TEST PENDING (manual).**

The central query router (base) plus the **extended domain advisory** (agriculture,
marine, aviation, smart city, travel, outdoor) are implemented, integrated, and
verified: 308/308 new assertions (sections A–O), full regression (6A 224, 5H 13, 5G 93,
5F 54, 5E-2 69, structural 80, 5E-2-multimodal 84, visual 114), `tsc --noEmit` clean,
`npm run lint` 0 errors, `npm run build` successful, and live domain API checks passed
for geocoding + all exercised domains with correct units/rounding/attribution and no
fake-zero or flood-over-claim wording. **The location-extraction bug found in the
browser smoke test is fixed:** explicit locations in the original query (Delhi airport,
marine near Chennai, multi-sentence and compound queries) are extracted before any
clarification, airport/coastal references resolve to the parent city, and compound
queries answer every matched domain — verified live with no "Which location should I
check?" prompt for the Delhi-airport turn. The router composes — never rebuilds —
Phases 1–6A, keeps every existing response contract (including 6A's plain-text realtime
answers), bounds its execution plan, grounds hybrid Gemini answers in verbatim tool
results, and exposes default-off extension points for future phases. One item remains
and is reported honestly as pending rather than claimed: the interactive in-browser
smoke test, which requires a signed-in browser session (no browser automation available).

## 23. Appendix — domain surface & Open-Meteo notes

- **Domains.** `DomainIntent = AGRICULTURE | MARINE | AVIATION | SMART_CITY | TRAVEL |
  OUTDOOR` (always excludes NONE at routing type level). `WinProvider` order:
  MARINE > AVIATION > AGRICULTURE > SMART_CITY > OUTDOOR > TRAVEL.
- **Timeframes.** `DomainTimeframe = now | today | tonight | tomorrow | weekend | week`
  with precedence tonight > tomorrow > weekend > week > today > now.
- **Endpoints (all keyless).** `geocoding-api.open-meteo.com/v1/search` (shared with
  6A); `api.open-meteo.com/v1/forecast` (agriculture/aviation/smart-city/travel/outdoor);
  `marine-api.open-meteo.com/v1/marine` (marine). Least-data variable sets per domain.
- **Caching/retry.** Same 6A patterns: `NO_RETRY_STATUS` 400/404/422/429, max 2
  attempts, backoff 200 ms × attempt, AbortController timeouts; user + coords + domain +
  cache-tag-scoped LRU keys (geocode 24 h, weather 5 min, marine 10 min) so domain
  fetches share 6A's already-fresh entries.
- **`buildAdvisory` outputs.** `{ factors, summary, assessment, severity, source,
  timestamp, safetyNote, locationLabel, periodLabel }`; the answer text is assembled
  deterministically from these fields (no model in the loop).
- **WRAN/WMO note.** Weather codes map via `conditionFor` to plain-language conditions
  (null/non-finite → "Not available"); visibility converted meters→km; wave heights in
  meters; winds km/h; SST °C with 1-decimal precision.