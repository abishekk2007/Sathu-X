// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: secret detection and safe logging.
//
// A memory store must NEVER persist credentials — even when the user explicitly
// asks ("remember my password…"). This module is the deterministic veto used by
// the policy layer, the store, the chat route and the memories API. It also
// provides log-scrubbing so diagnostics never echo secret material.
//
// Deliberately regex/keyword based (no LLM): a credential is a credential no
// matter how it is phrased, and refusing must be instant and cheap.
// ---------------------------------------------------------------------------

/** Keywords that mark a labelled credential claim ("my password is …"). */
const SENSITIVE_LABEL_PATTERN =
  /\b(pass(word|code|phrase|key)?s?|api[-\s_]?keys?|apikeys?|access[-\s]?tokens?|auth[-\s]?tokens?|bearer\s+tokens?|jwt|credentials?|secrets?|private[-\s]?keys?|secret[-\s]?keys?|client[-\s]?secrets?|refresh[-\s]?tokens?|otp|one[-\s]?time\s+passwords?|verification\s+codes?|cvv|cvc|pin\b|credit[-\s]?cards?|debit[-\s]?cards?|card\s+numbers?|pan\s+numbers?|security\s+(questions?|answers?)|recovery\s+codes?|2fa|two[-\s]?factor|mfa|connection\s+strings?|database[-\s]?urls?|dsn)\b/i;

/** Recognized secret-value shapes found with or without a label. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // Google API keys.
  /\bAIza[0-9A-Za-z_\-]{20,}\b/,
  // OpenAI-style keys.
  /\bsk-[0-9A-Za-z_\-]{20,}\b/,
  // GitHub personal access tokens.
  /\bghp_[0-9A-Za-z]{30,}\b/,
  // Slack tokens.
  /\bxox[baprs]-[0-9A-Za-z\-]{10,}\b/,
  // AWS access key id (+ surrounding secret-id pair).
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  // Private key blocks (PEM).
  /-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN (OPENSSH |RSA |EC )?PUBLIC KEY-----/i,
  // Connection-string URIs that would grant database access.
  /\b(postgres(ql)?|mysql|redis|mongodb(\+srv)?|amqp|rabbitmq):\/\/[^\s"']+/i,
  /\b(sqlserver|jdbc|snowflake|cockroachdb|neo4j):\/\/\S+/i,
  // Full OAuth bearer tokens.
  /\beyJ[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{8,}\.[0-9A-Za-z_\-]{10,}\b/,
  // Long high-entropy blobs (base64/hex/slug secrets ≥ 32 chars in a labelled
  // secret context). Never flags ordinary base64 images — those have data URLs.
  /\b(?:key|token|secret|password)\b[\s:=]{1,3}[A-Za-z0-9+/_\-]{32,}={0,2}/i,
  // 16-digit card runs with optional grouping.
  /\b(?:\d[ -]?){13,19}\b/,
];

/**
 * True when the text reads like a credential claim or embeds a secret value.
 * Used both pre-LLM (refuse early) and post-LLM (defense-in-depth on the
 * candidate a model produced).
 */
export function looksSensitive(text: string): boolean {
  if (!text) return false;
  if (SENSITIVE_LABEL_PATTERN.test(text)) return true;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 8D — Raw-location protection.
//
// "Remember my location" style requests are durable by nature, but a raw
// lat/lng pair or a precise coordinate blob is personal-location PII that a
// memory store should NOT persist verbatim (the user directive for 8D is
// explicit: DO NOT store raw coordinates). We veto raw coordinate VALUES while
// still politely allowing textual place names ("I live in Chennai") which are
// ordinary profile facts. A coordinate is recognizable by its shape: a signed
// decimal pair, DMS triple, or GPS-style coordinate string.
// ---------------------------------------------------------------------------

const LOCATION_VALUE_PATTERNS: RegExp[] = [
  // Decimal lat/lng pair and variants: "12.9716, 77.5946", "12.9716° N, 77.5946° E",
  // "28.61N 77.20E", "40.7128, -74.0060".
  /\b[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\s*[°º]?\s*[NSEWnsew]?\s*[,;]\s*[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\s*[°º]?\s*[NSEWnsew]?\b/,
  // DMS triple: "12°58'18\"N 77°35'41\"E".
  /\b\d{1,3}\s*[°º]\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*["″]?\s*[NSEWnsew]?\s+[+-]?\d{1,3}\s*[°º]\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*["″]?\s*[NSEWnsew]?\b/,
  // GPS/coordinate sud labels with explicit "lat/long" prefix
  // (e.g. "lat 12.97, long 77.59").
  /\b(?:lat(?:itude)?\s*[:=]?\s*[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\s*[,;]?\s*)?(?:lon|long|lng|longitude)\s*[:=]?\s*[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\b/i,
];

/**
 * True when the text embeds a raw geographic coordinate (decimal pair, DMS
 * triple, or GPS-style point). Detected independent of `looksSensitive` so the
 * policy layer can refuse to persist raw coordinates without conflating them
 * with credentials. Plain place names ("Chennai", "I live in Ooty") are NOT
 * flagged.
 */
export function looksLikeRawLocation(text: string): boolean {
  if (!text) return false;
  for (const pattern of LOCATION_VALUE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

const REDACT = "[REDACTED]";

/** Regex set used to scrub secret-shaped material from log lines. */
const REDACTION_PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_\-]{20,}\b/g,
  /\bsk-[0-9A-Za-z_\-]{20,}\b/g,
  /\bghp_[0-9A-Za-z]{30,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z\-]{10,}\b/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(postgres(ql)?|mysql|redis|mongodb(\+srv)?|amqp|rabbitmq):\/\/[^\s"']+/gi,
  /\b(sqlserver|jdbc|snowflake|cockroachdb|neo4j):\/\/\S+/gi,
  /\beyJ[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{8,}\.[0-9A-Za-z_\-]{10,}\b/g,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(key|token|secret|password)\b[\s:=]{1,3}[A-Za-z0-9+/_\-]{32,}={0,2}/gi,
  /\b\d[ -]?(?:\d[ -]?){15,19}\b/g,
  // Phase 8D — raw-coordinate scrubbing so logs never echo a location point.
  /\b[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\s*[°º]?\s*[NSEWnsew]?\s*[,;]\s*[-+]?(?:1[0-7]\d|\d{1,2})\.\d{2,}\s*[°º]?\s*[NSEWnsew]?\b/g,
  /\b\d{1,3}\s*[°º]\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*["″]?\s*[NSEWnsew]?\s+[+-]?\d{1,3}\s*[°º]\s*\d{1,2}\s*['′]\s*\d{1,2}(?:\.\d+)?\s*["″]?\s*[NSEWnsew]?\b/g,
];

/**
 * Scrubs secret-shaped material from an arbitrary string so diagnostics can
 * safely echo it. Deterministic, fast, never blocks.
 */
export function sanitizeForLog(text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of REDACTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, REDACT);
  }
  // Phase 8D — also scrub any raw coordinates that survived the line above.
  cleaned = cleaned.replace(
    /[-+]?(?:1[0-7]\d|\d{1,2})\.\d{3,}\s*[NSEW]\s+[-+]?(?:1[0-7]\d|\d{1,2})\.\d{3,}\s*[NSEW]/g,
    REDACT
  );
  // Label + value in prose ("password is swordfish") → keep the label, cut
  // the value, but only when the string also looks like a credential claim.
  if (SENSITIVE_LABEL_PATTERN.test(cleaned)) {
    cleaned = cleaned.replace(
      /(\b(?:password|passcode|passphrase|secret|token|key|pin|otp|cvv|pan)\b)[\s:=]+("[^"]*"|'[^']*'|[^.!?;]+)/gi,
      (_match, label: string) => `${label} ${REDACT}`
    );
  }
  return cleaned;
}

/**
 * Bounded, redacted snippet of a memory for logs / diagnostics.
 * Internal identity fields (id, timestamps) are never included.
 */
export function describeMemoryForLog(memory: {
  type?: string;
  content: string;
  source?: string;
  confidence?: string;
}): string {
  const content = sanitizeForLog(memory.content.slice(0, 200));
  const tags = [
    memory.type ? `type=${memory.type}` : null,
    memory.source ? `source=${memory.source}` : null,
    memory.confidence ? `confidence=${memory.confidence}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return tags ? `${tags} content="${content}"` : `content="${content}"`;
}