// ---------------------------------------------------------------------------
// Phase 6B Extended — Domain real-time advisory engine (orchestrator).
//
//   intent detection (= domain)  →  data retrieval (Open-Meteo / Marine)  →
//   deterministic advisory engine  →  structured DomainToolResult
//
// The DOMAINS are sub-routes of real-time advisory: AGRICULTURE, MARINE,
// AVIATION, SMART_CITY, TRAVEL, OUTDOOR. Detection is pure and rule-based (no
// LLM), reuses 6A's weather location extractor for context inheritance, and
// never fires from casual chat or definition/story requests.
//
// Grounding invariant: every number in the advisory comes verbatim from the
// provider payload. Gemini (only ever used to *explain* a hybrid result) is
// given the advisory through buildDomainSystemInstruction and is forbidden to
// invent measurements.
// ---------------------------------------------------------------------------

import { detectWeather } from "./intent";
import { fetchMarineConditions } from "./marine";
import { fetchDomainWeather } from "./domain-weather";
import { buildAdvisory, type Severity } from "./advisory";

export type DomainIntent =
  | "NONE"
  | "AGRICULTURE"
  | "MARINE"
  | "AVIATION"
  | "SMART_CITY"
  | "TRAVEL"
  | "OUTDOOR";

export type DomainTimeframe = "now" | "today" | "tonight" | "tomorrow" | "week";

export interface DomainDecision {
  domain: DomainIntent;
  handled: boolean;
  /** Resolved location (from the message, or inherited from prior turns). */
  location: string | null;
  locationInherited?: boolean;
  timeframe: DomainTimeframe;
  timeframeExplicit: boolean;
  /** True when the message is a bare "what about <domain>" follow-up. */
  isFollowUpPhrase?: boolean;
  /**
   * Additional domains that ALSO match the same compound/multi-sentence query
   * ("at Delhi airport and is heavy rainfall expected tonight?" → primary
   * AVIATION, related SMART_CITY). The chat route runs them as extra
   * advisories; a HYBRID turn grounds only the primary decision.
   */
  relatedDomains?: DomainDecision[];
  /** 0..1 heuristic — guidance only, never authoritative. */
  confidence: number;
  reason: string;
  /** Data factors the domain needs (least-data principle). */
  factors: string[];
}

export interface DomainToolResult {
  success: boolean;
  domain: DomainIntent;
  answer: string;
  /** Provider attribution (data provider — never credited with the advisory). */
  source: string;
  timestamp: string;
  forecastPeriod?: string;
  severity?: Severity;
  details?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Deterministic intent detection
// ---------------------------------------------------------------------------

const QUESTION_SIGNAL =
  /\b(?:is|are|will|can|could|should|how|what|when|whether|likely|suitable|good|bad|expected|comfortable|affect|weather|forecast|briefing|conditions?)\b|[?]\s*$/i;

const STORY_TRIGGER = /^\s*(?:tell|write|create|give)\b/i;
const EXPLAIN_TRIGGER = /^\s*(?:explain|describe)\b/i;
const KNOWLEDGE_WORDS = /\b(?:biology|meaning|definition|concept|science|career|careers?|profession|degree|courses?|history)\b/i;
const WHAT_IS = /^\s*(?:what|which)\s+(?:is|are)\s+/i;

const DOMAIN_WEATHER_CONTEXT =
  /\b(?:weather|forecast|rain|wind|humidity|temperature|season|conditions?|tomorrow|tonight|today|weekend|this\s+week|now)\b/i;

const TRAVEL_WORDS = /\b(?:travel|travell?ing\b|traveling|tour|journey|vacation|holiday)\b/i;
const TRIP_WORD = /\btrip\b/i;

const OUTDOOR_WORDS =
  /\b(?:running|run|jog|jogging|cycling|cycle|bicycl|bike|picnic|outdoor|outdoors|hike|hiking|walk|walking|playing|sports?|event|exercise|workout)\b/i;

const OUTDOOR_QUESTION =
  /\b(?:is\s+it|can\s+i|should\s+i|good\s+for|suitable\s+for|comfortable\s+for|will\s+the\s+weather|how\s+is|what\s+is)\b/i;

const AGRICULTURE_ACTION =
  /\b(?:spray|spraying|pesticide|fertiliz|irrigat|planting|crop\s+protection|field\s+work)\b/i;
const AGRICULTURE_SUITABLE =
  /\b(?:good|bad|suitable|safe)\s+for\s+(?:agriculture|farming|agricultural\s+work|crops?|crop\s+|crop\s+protection|the\s+farm|field|harvesting|spraying)\b/i;
/** Advisory-adjacent words that accept an AGRICULTURE token into a domain turn. */
const AGRICULTURE_WORK =
  /\b(?:weather|forecast|outlook|rain|wind|humidity|temperature|condition|field|work|planting|morrow|tomorrow|tonight|today|weekend|spray|spraying|pesticide|fertiliz|irrigat|protect|treat)\b/i;
const AGRICULTURE_TOKENS = /\b(?:farming|farm\b|farmer|crops?|agriculture|agricultural)\b/i;

const MARINE_STRONG =
  /\b(?:marine\s+operations?|maritime|sea\s+conditions|sea\s+state|nautical|sailing|swell|wave\s+height|waves?|vessel|harbou?r|shipping|tides?|tidal|marine)\b/i;
const MARINE_WEAK = /\b(?:sea\b|ocean|coast|coastal|fishing|boat)\b/i;
const MARINE_CONTEXT =
  /\b(?:conditions?|rough|calm|state|height|period|suitable|operations?|forecast|navigat|wind|weather|storm)\b/i;

const AVIATION_STRONG =
  /\b(?:airport|airfield|aviation|runway|take-?off|landing|pilot|aircraft|air\s+traffic|approach|visibility\s+at)\b/i;
const AVIATION_FLIGHT = /\b(?:flight|fly|flying)\b/i;
/** Weather-words that let a "flight" mention join the aviation advisory. */
const AVIATION_WORK = /\b(?:weather|conditions?|forecast|visibility|wind|rain|cloud|briefing|airport)\b/i;

const SMART_CITY_STRONG =
  /\b(?:flood|flooding|drainage|heavy\s+rain|heavy\s+rainfall|rainfall|torrential|downpour|storm\s+surge|urban|citywide)\b/i;
const SMART_CITY_WIND = /\bstrong\s+wind(?:s|y)?\b/i;
const SMART_CITY_WIND_CTX = /\b(?:tonight|overnight|prepare|alert|watch|should)\b/i;

const FOLLOW_UP_PHRASE = /^\s*(?:what|how)\s+about\s+(.+?)[?.!]*\s*$/i;

const FOLLOW_UP_DOMAINS: Array<[RegExp, Exclude<DomainIntent, "NONE">]> = [
  [/\b(?:farming|agriculture|agricultural\s+work|spraying|spray|pesticide|crops?|harvest)\b/i, "AGRICULTURE"],
  [/\b(?:marine|sea|ocean|waves?|swell|fishing|marine\s+operations)\b/i, "MARINE"],
  [/\b(?:aviation|airport)\b/i, "AVIATION"],
  [/\b(?:running|cycling|picnic|outdoor|hiking)\b/i, "OUTDOOR"],
  [/\b(?:travel|travell?ing|trip|journey)\b/i, "TRAVEL"],
  [/\b(?:rain|weather|flood|storm)\b/i, "SMART_CITY"],
];

// Ordered: the first (most specific) match wins.
const PRECEDENCE: Exclude<DomainIntent, "NONE">[] = ["MARINE", "AVIATION", "AGRICULTURE", "SMART_CITY", "OUTDOOR", "TRAVEL"];

const DEF_ANCHORS: Record<Exclude<DomainIntent, "NONE">, RegExp> = {
  AGRICULTURE: /^\s*(?:what|which)\s+(?:is|are)\s+(?:a\s+|an\s+|the\s+)?(?:farming|agriculture|a\s+crop|farms?|a\s+farmer)/i,
  MARINE: /^\s*(?:what|which)\s+(?:is|are)\s+(?:the\s+|a\s+|an\s+)?(?:marine\s+(?:biology|science)|ocean|sea)\b/i,
  AVIATION: /^\s*(?:what|which)\s+(?:is|are)\s+(?:the\s+)?(?:aviation|an\s+airport|flight)\b/i,
  SMART_CITY: /^\s*(?:what|which)\s+(?:is|are)\s+(?:a\s+|an\s+)?(?:flood|flooding)\b/i,
  TRAVEL: /^\s*(?:what|which)\s+(?:is|are)\s+(?:a\s+|an\s+)?(?:trip|journey)\b/i,
  OUTDOOR: /^\s*(?:what|which)\s+(?:is|are)\s+(?:an?\s+)?(?:run|hike|picnic)\b/i,
};

export function extractTimeframe(message: string): DomainTimeframe {
  const text = message.toLowerCase();
  if (/\b(?:tonight|this\s+evening|this\s+night|overnight)\b/.test(text)) return "tonight";
  if (/\b(?:day\s+after\s+tomorrow|tomorrow)\b/.test(text)) return "tomorrow";
  if (/\b(?:this\s+week(?:end)?|next\s+week|weekend)\b/.test(text)) return "week";
  if (/\b(?:today|this\s+afternoon|right\s+now|now|current)\b/.test(text)) return "today";
  return "now";
}

/** Domain-generic tail words that are NOT locations ("marine operations"). */
const GENERIC_TAIL =
  /\b(?:operations?|conditions?|state|forecast|briefing|outlook|runway|take-?off|landing|airport|harbou?r|port|coast|beach|shore|offshore|wave|swell|sea|ocean|flood|flooding|event|events|field|fields|boat|boats|trip|travel|travelling|traveling|tour|journey|vacation|holiday|fishing|sailing|farming|agriculture|crops?|weather|the|a|an|this|that|for|me|my|please|tell|like|activities?)\b/i;

function isCredibleDomainLocation(location: string): boolean {
  const cleaned = location.trim().toLowerCase();
  return cleaned.length > 0 && !GENERIC_TAIL.test(cleaned);
}

/**
 * Suffixes that mark a place REFERENCE ("Chennai airport", "Mumbai coast")
 * rather than the place itself. Stripped before credibility checks so the
 * user never has to repeat the city after an airport/coastal phrasing.
 */
const PLACE_REF_SUFFIX = /\s+(?:airport|airfield|coast|coastal|beach|shore|offshore)\s*$/i;

/**
 * Words that a `<City> weather` adjacency capture (e.g. "today's Delhi
 * weather", "the weather") must never be read as a place name.
 */
const NON_PLACE_HINT =
  /\b(?:todays?|tonights?|tomorrows?|yesterdays?|weekends?|this\s+week(?:end)?|this|that|the|its|it's|next|current|upcoming|local|weekly|daily|what|weather|forecast|conditions?)\b/i;

/** A single candidate spanning two places ("Chennai and Delhi") is ambiguous. */
const MULTI_PLACE = /\b(?:and|&|or)\b/i;

const CITY_CAPTURE = "([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})";
const CITY_CAPTURE_LAZY = "([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39}?)";

function cleanExtractedLocation(raw: string): string | null {
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/\s+(?:tomorrow|tonight|today|now|right\s+now|soon|this\s+week(?:end)?)\s*$/i, "")
    .trim();
  cleaned = cleaned.replace(/['’]s\s*$/i, "").trim();
  cleaned = cleaned.replace(PLACE_REF_SUFFIX, "").trim();
  if (!cleaned) return null;
  // Never pick one side of "in Chennai and Delhi" — that is ambiguous.
  if (MULTI_PLACE.test(cleaned) || cleaned.includes(",")) return null;
  return isCredibleDomainLocation(cleaned) ? cleaned : null;
}

/**
 * Robust explicit-location extraction used by both the domain detector and
 * the router's real-time probes. Inspects the ENTIRE query (across multiple
 * sentences) so an explicit place is picked up before the tool ever asks
 * "Which location should I check?". Priority per phrase:
 *   1. subject-flood ("Will Chennai flood tonight?"), per sentence;
 *   2. last-preposition tail ("rain in Mumbai tomorrow"), per sentence;
 *   3. airport/airfield phrase anywhere ("at Delhi airport … and … tonight?");
 *   4. `<City> weather` adjacency ("today's Delhi weather").
 * Never returns arbitrary prose or a caption word as a location.
 */
export function extractQueryLocation(message: string): string | null {
  const sentences = message
    .replace(/[?!.]+$/, "")
    .split(/[.!?\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return null;

  for (const s of sentences) {
    const subject = s.match(
      /^(?:will|is|shall|should|can|could)\s+([A-Z][A-Za-z\u00C0-\u017F .'’-]{1,39}?)\s+(?:flood|flooding|receive|see|hit)\b/i
    );
    if (subject) {
      const loc = cleanExtractedLocation(subject[1].trim());
      if (loc) return loc;
    }
  }

  // Last-preposition tail: `.*` forces the group to the FINAL preposition so
  // "good for marine operations near Chennai" yields "Chennai", never
  // "marine operations near Chennai" (the pre-fix leftmost-match bug).
  for (const s of sentences) {
    const tail = s.match(RegExp(`.*\\b(?:in|for|at|to|near)\\s+${CITY_CAPTURE}$`, "i"));
    if (tail) {
      const loc = cleanExtractedLocation(tail[1].trim());
      if (loc) return loc;
    }
  }

  for (const s of sentences) {
    const airport = s.match(
      RegExp(`\\b(?:at|in|near|for|to)\\s+${CITY_CAPTURE_LAZY}\\s+(?:airport|airfield)\\b`, "i")
    );
    if (airport) {
      const loc = cleanExtractedLocation(airport[1].trim());
      if (loc) return loc;
    }
  }

  for (const s of sentences) {
    // City-adjacent weather noun ("today's Delhi weather", "the Mumbai
    // forecast"). Scan each weather-noun occurrence and try every preceding
    // token-run shortest-to-longest so overlapping candidates like
    // "today's Delhi weather" still yield "Delhi".
    const nounRe = /\b(?:weather|forecast|conditions?)\b/gi;
    let noun: RegExpExecArray | null;
    while ((noun = nounRe.exec(s)) !== null) {
      const before = s.slice(0, noun.index).trimEnd();
      const m = before.match(/\b([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{0,38})$/);
      if (!m) continue;
      const tokens = m[1].split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i -= 1) {
        // Proper-noun adjacency only — "marine conditions" (domain noun) must
        // never read as a location, so a bare follow-up inherits a past city.
        if (!/^[A-Z\u00C0-\u017F]/.test(tokens[i])) continue;
        const loc = cleanExtractedLocation(tokens.slice(i).join(" "));
        if (loc && !NON_PLACE_HINT.test(loc)) return loc;
      }
    }
  }

  return null;
}

function extractDomainLocation(message: string): string | null {
  return extractQueryLocation(message);
}

function hasKnowledgeIntent(message: string): boolean {
  if (FOLLOW_UP_PHRASE.test(message)) return false;
  if (STORY_TRIGGER.test(message) && /\b(?:story|stories)\b/i.test(message)) return true;
  if (EXPLAIN_TRIGGER.test(message) && KNOWLEDGE_WORDS.test(message)) return true;
  if (WHAT_IS.test(message) && KNOWLEDGE_WORDS.test(message)) return true;
  return false;
}

function isDefinitionOf(
  domain: Exclude<DomainIntent, "NONE">,
  message: string
): boolean {
  const anchor = DEF_ANCHORS[domain];
  return anchor ? anchor.test(message) : false;
}

/** Factors (least-data principle) + cache tags for the data layer. */
const DOMAIN_FACTORS: Record<Exclude<DomainIntent, "NONE">, { hourly: string[]; factors: string[] }> = {
  AGRICULTURE: {
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "precipitation_probability",
      "wind_speed_10m",
      "wind_gusts_10m",
      "relative_humidity_2m",
      "weather_code",
    ],
    factors: ["rain", "wind", "temperature", "humidity"],
  },
  AVIATION: {
    hourly: [
      "temperature_2m",
      "wind_speed_10m",
      "wind_gusts_10m",
      "wind_direction_10m",
      "precipitation",
      "precipitation_probability",
      "visibility",
      "cloud_cover",
      "surface_pressure",
      "weather_code",
    ],
    factors: ["visibility", "cloud_cover", "wind", "precipitation", "pressure", "temperature"],
  },
  SMART_CITY: {
    hourly: [
      "temperature_2m",
      "precipitation",
      "precipitation_probability",
      "rain",
      "showers",
      "wind_speed_10m",
      "wind_gusts_10m",
      "cloud_cover",
      "visibility",
      "weather_code",
    ],
    factors: ["rain", "wind_gusts", "cloud_cover", "visibility"],
  },
  TRAVEL: {
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "precipitation_probability",
      "wind_speed_10m",
      "visibility",
      "weather_code",
    ],
    factors: ["temperature", "rain", "wind", "visibility"],
  },
  OUTDOOR: {
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "precipitation_probability",
      "wind_speed_10m",
      "weather_code",
    ],
    factors: ["temperature", "rain", "wind"],
  },
  MARINE: {
    hourly: [],
    factors: ["wave_height", "wave_period", "swell", "wind", "precipitation"],
  },
};

/**
 * Detects whether the current message asks for a domain-specific real-time
 * advisory (agriculture / marine / aviation / smart-city / travel / outdoor).
 * Pure, deterministic, and deliberately conservative so casual chat never
 * reaches a weather provider.
 */
export function detectDomainIntent(message: string): DomainDecision {
  const trimmed = message.trim();
  if (!trimmed) {
    return { domain: "NONE", handled: false, location: null, timeframe: "now", timeframeExplicit: false, confidence: 0, reason: "Empty message.", factors: [] };
  }

  const followUp = trimmed.match(FOLLOW_UP_PHRASE);
  if (followUp) {
    const noun = followUp[1];
    for (const [pattern, domain] of FOLLOW_UP_DOMAINS) {
      if (pattern.test(noun)) {
        return {
          domain,
          handled: true,
          location: extractDomainLocation(trimmed),
          timeframe: extractTimeframe(noun),
          timeframeExplicit: false,
          isFollowUpPhrase: true,
          confidence: 0.78,
          reason: `Bare domain follow-up ("what about ${noun.trim()}").`,
          factors: DOMAIN_FACTORS[domain].factors,
        };
      }
    }
    return { domain: "NONE", handled: false, location: null, timeframe: extractTimeframe(trimmed), timeframeExplicit: true, confidence: 0, reason: "No domain noun in the follow-up phrase.", factors: [] };
  }

  if (hasKnowledgeIntent(trimmed)) {
    return { domain: "NONE", handled: false, location: null, timeframe: "now", timeframeExplicit: false, confidence: 0, reason: "Knowledge/definition/story request — general knowledge, not an advisory.", factors: [] };
  }
  if (!QUESTION_SIGNAL.test(trimmed)) {
    return { domain: "NONE", handled: false, location: null, timeframe: "now", timeframeExplicit: false, confidence: 0, reason: "Not a question/request — no domain trigger.", factors: [] };
  }

  const location = extractDomainLocation(trimmed);
  const timeframe = extractTimeframe(trimmed);
  const timeframeExplicit = timeframe !== "now" || /\b(?:now|current|right\s+now)\b/i.test(trimmed);

  const domainHit = (): Exclude<DomainIntent, "NONE">[] => {
    const hits: Exclude<DomainIntent, "NONE">[] = [];
    for (const candidate of PRECEDENCE) {
      if (matchesDomain(candidate, trimmed) !== "match") continue;
      if (isDefinitionOf(candidate, trimmed)) continue;
      hits.push(candidate);
    }
    return hits;
  };

  const hits = domainHit();
  if (hits.length === 0) {
    return { domain: "NONE", handled: false, location: null, timeframe, timeframeExplicit, confidence: 0, reason: "No domain-specific signal matched.", factors: [] };
  }

  const hit = hits[0];
  const domainConfig = DOMAIN_FACTORS[hit];
  const hitConfidence = location ? 0.94 : 0.85;
  const related: DomainDecision[] = hits
    .slice(1)
    .map((d) => {
      const relatedConfig = DOMAIN_FACTORS[d];
      return {
        domain: d,
        handled: true,
        location,
        timeframe,
        timeframeExplicit,
        confidence: hitConfidence,
        reason: `Secondary domain ${d} for the same compound/multi-sentence query (${location ? `location "${location}"` : "no explicit location"}, timeframe ${timeframe}).`,
        factors: relatedConfig.factors,
      };
    });

  return {
    domain: hit,
    handled: true,
    location,
    timeframe,
    timeframeExplicit,
    confidence: hitConfidence,
    reason: `Domain intent ${hit} (${location ? `location "${location}"` : "no explicit location"}, timeframe ${timeframe}).`,
    factors: domainConfig.factors,
    ...(related.length > 0 ? { relatedDomains: related } : {}),
  };
}

function matchesDomain(domain: DomainIntent, message: string): "match" | "none" {
  const lower = message.toLowerCase();
  switch (domain) {
    case "AGRICULTURE":
      if (AGRICULTURE_ACTION.test(lower)) return "match";
      if (AGRICULTURE_SUITABLE.test(lower)) return "match";
      if (AGRICULTURE_TOKENS.test(lower) && AGRICULTURE_WORK.test(lower)) return "match";
      return "none";
    case "MARINE":
      if (MARINE_STRONG.test(lower)) return "match";
      if (MARINE_WEAK.test(lower) && MARINE_CONTEXT.test(lower)) return "match";
      return "none";
    case "AVIATION":
      if (AVIATION_STRONG.test(lower)) return "match";
      if (AVIATION_FLIGHT.test(lower) && AVIATION_WORK.test(lower)) return "match";
      return "none";
    case "SMART_CITY":
      if (SMART_CITY_STRONG.test(lower)) return "match";
      if (SMART_CITY_WIND.test(lower) && SMART_CITY_WIND_CTX.test(lower)) return "match";
      return "none";
    case "TRAVEL":
      if (TRAVEL_WORDS.test(lower)) return "match";
      if (TRIP_WORD.test(lower) && DOMAIN_WEATHER_CONTEXT.test(lower)) return "match";
      return "none";
    case "OUTDOOR":
      if (OUTDOOR_WORDS.test(lower) && OUTDOOR_QUESTION.test(lower)) return "match";
      return "none";
    default:
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Context inheritance (STEP 29 / 30 / 31)
// ---------------------------------------------------------------------------

/**
 * Inherits a location/timeframe from prior turns, but ONLY when the previous
 * real-time or domain context resolves to exactly one consistent location.
 * Multiple distinct locations → no inheritance (the user is asked instead).
 */
export function resolveDomainContext(
  decision: DomainDecision,
  priorTurns?: Array<{ role: string; content: string }>
): DomainDecision {
  if (!decision.handled) return decision;

  const users = (priorTurns ?? []).filter((t) => t.role === "user").slice(-3);
  const locations = new Set<string>();
  let inheritedTimeframe: DomainTimeframe | null = null;

  for (const turn of users) {
    const weather = detectWeather(turn.content);
    if (weather?.params?.location && weather.params.location.trim()) {
      locations.add(weather.params.location.trim());
    }
    const domain = detectDomainIntent(turn.content);
    if (domain.handled && domain.location) {
      locations.add(domain.location);
    }
    const tf = extractTimeframe(turn.content);
    if (tf !== "now" && inheritedTimeframe === null) inheritedTimeframe = tf;
  }

  let next = decision;
  if (!next.location && locations.size === 1) {
    next = {
      ...next,
      location: [...locations][0],
      locationInherited: true,
      confidence: Math.max(next.confidence, 0.9),
      reason: `${next.reason} Location inherited from conversation context ("${[...locations][0]}").`,
    };
  }
  if (!next.timeframeExplicit && inheritedTimeframe !== null) {
    next = { ...next, timeframe: inheritedTimeframe };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Execution orchestrator
// ---------------------------------------------------------------------------

function forecastDaysFor(timeframe: DomainTimeframe): number {
  switch (timeframe) {
    case "tonight":
      return 2;
    case "tomorrow":
      return 2;
    case "week":
      return 7;
    default:
      return 1;
  }
}

function normalizeLocation(domain: DomainIntent, location: string): string {
  const loc = location.trim();
  if (domain === "MARINE") {
    const stripped = loc.replace(/\b(?:coast|beach|shore|offshore|port|harbou?r)\b.*$/i, "").trim();
    return stripped || loc;
  }
  return loc;
}

function fail(domain: DomainIntent, error: { code: string; message: string }): DomainToolResult {
  return {
    success: false,
    domain,
    answer: error.message,
    source: "open-meteo",
    timestamp: new Date().toISOString(),
    error,
  };
}

/** Runs the advisory pipeline for a resolved domain decision. Never throws. */
export async function executeDomainTool(input: {
  decision: DomainDecision;
  userId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<DomainToolResult> {
  const decision = input.decision;
  const now = input.now ?? (() => new Date());

  if (!decision.handled || decision.domain === "NONE") {
    return fail(decision.domain, { code: "domain_not_handled", message: "I couldn't work out which advisory you wanted." });
  }
  if (!decision.location) {
    return {
      success: false,
      domain: decision.domain,
      answer: "Which location should I check? For example: \"Can I spray pesticide in Coimbatore tomorrow?\" or \"marine conditions near Chennai\".",
      source: "open-meteo",
      timestamp: now().toISOString(),
      error: { code: "location_required", message: "Which location should I check?" },
    };
  }

  try {
    if (decision.domain === "MARINE") {
      const marine = await fetchMarineConditions({
        location: normalizeLocation(decision.domain, decision.location),
        forecastDays: forecastDaysFor(decision.timeframe),
        userId: input.userId,
        fetchImpl: input.fetchImpl,
      });
      if (!marine.success || !marine.geo || !marine.payload) {
        return fail(decision.domain, marine.error ?? { code: "marine_error", message: "Live marine information isn't available right now." });
      }
      const advisory = buildAdvisory({
        domain: decision.domain,
        geo: marine.geo,
        payload: marine.payload,
        timeframe: decision.timeframe,
      });
      return {
        success: true,
        domain: decision.domain,
        answer: advisory.answer,
        source: "open-meteo-marine",
        timestamp: now().toISOString(),
        forecastPeriod: advisory.forecastPeriod,
        severity: advisory.severity,
        details: {
          provider: "open-meteo-marine",
          domain: decision.domain,
          location: decision.location,
          latitude: marine.geo.latitude,
          longitude: marine.geo.longitude,
          factors: advisory.factors.map((f) => ({ key: f.key, value: f.value, unit: f.unit })),
        },
      };
    }

    const config = DOMAIN_FACTORS[decision.domain];
    const forecast = await fetchDomainWeather({
      location: normalizeLocation(decision.domain, decision.location),
      hourly: config.hourly,
      forecastDays: forecastDaysFor(decision.timeframe),
      userId: input.userId,
      fetchImpl: input.fetchImpl,
      cacheTag: decision.domain.toLowerCase(),
    });
    if (!forecast.success || !forecast.geo || !forecast.payload) {
      return fail(decision.domain, forecast.error ?? { code: "domain_weather_error", message: "Live weather information isn't available right now." });
    }
    const advisory = buildAdvisory({
      domain: decision.domain,
      geo: forecast.geo,
      payload: forecast.payload,
      timeframe: decision.timeframe,
    });
    return {
      success: true,
      domain: decision.domain,
      answer: advisory.answer,
      source: "open-meteo",
      timestamp: now().toISOString(),
      forecastPeriod: advisory.forecastPeriod,
      severity: advisory.severity,
      details: {
        provider: "open-meteo",
        domain: decision.domain,
        location: decision.location,
        latitude: forecast.geo.latitude,
        longitude: forecast.geo.longitude,
        factors: advisory.factors.map((f) => ({ key: f.key, value: f.value, unit: f.unit })),
      },
    };
  } catch {
    return fail(decision.domain, { code: "domain_error", message: "Something went wrong retrieving that information. Please try again." });
  }
}

/**
 * Grounding block for HYBRID turns where a Gemini explanation is built around
 * a domain advisory: the advisory text (all provider-measured) is injected
 * verbatim so the model can never invent numbers or approval.
 */
export function buildDomainSystemInstruction(result: DomainToolResult): string {
  const valueLine = result.success
    ? `The advisory tool's output is below — every measurement came from the live provider.`
    : `The advisory tool could not produce an assessment (error: ${result.error?.code ?? "unknown"}). ` +
      "Do NOT invent measurements or an assessment; explain the failure briefly and safely.";
  return (
    "DOMAIN WEATHER ADVISORY (real-time tool result)\n\n" +
    `Domain: ${result.domain}\n` +
    `Retrieved: ${result.timestamp}\n\n` +
    `${valueLine}\n\n` +
    `${result.success ? result.answer : ""}\n\n` +
    "Rules: Use exactly the measurements and assessment above. Never recalculate, estimate, " +
    "or substitute values. This is an application-level weather-based assessment — it is NOT " +
    "official approval, a navigation/aviation clearance, or a flood prediction. Do not claim any " +
    "of those even if asked."
  );
}