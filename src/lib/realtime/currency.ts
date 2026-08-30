// ---------------------------------------------------------------------------
// Phase 6A — Currency tool (provider-backed, safe).
//
//   - Provider: ExchangeRate-API (API key via EXCHANGE_RATE_API_KEY, server-side).
//   - No key configured  -> `currency_not_configured` (never invents rates).
//   - AbortController timeout + bounded retries (max 2 attempts). NO retry on
//     4xx (bad key / unknown pair / rate limit) — surfaced once.
//   - Short-TTL LRU cache (10 min) with user+from+to in the key; cached rate
//     is never treated as "current" past its TTL.
//   - Conversion math done from the provider's reported rate.
//   - Safe error messages: no API keys, no internal URLs, no stack traces.
//   - Provider data timestamp is labelled `UTC` explicitly.
// ---------------------------------------------------------------------------

import { dedupeInFlight, LRU } from "../cache";

export interface CurrencyToolInput {
  from: string;
  to: string;
  amount: number;
  userId?: string;
  fetchImpl?: typeof fetch;
  /** Test knob — overrides the default provider timeout. */
  timeoutMs?: number;
  /** Test knob — overrides the default retry budget. */
  maxAttempts?: number;
  /** Test knob — overrides the default retry backoff. */
  backoffMs?: number;
}

export interface CurrencyToolOutput {
  success: boolean;
  answer?: string;
  error?: { code: string; message: string };
  details: Record<string, unknown>;
}

export const CURRENCY_TIMEOUT_MS = 6_000;
export const CURRENCY_MAX_ATTEMPTS = 2;
export const CURRENCY_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedCurrency {
  answer: string;
  from: string;
  to: string;
  rate: number;
  fetchedAtIso: string;
  details: Record<string, unknown>;
}

const currencyCache = new LRU<string, CachedCurrency>(200, CURRENCY_CACHE_TTL_MS);

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (fetchImpl ?? globalThis.fetch)(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface RequestOutcome {
  ok: boolean;
  status?: number;
  attempts: number;
  timedOut?: boolean;
  response?: Response;
}

async function requestWithRetry(
  url: string,
  opts: {
    timeoutMs: number;
    maxAttempts: number;
    fetchImpl?: typeof fetch;
    backoffMs?: number;
  }
): Promise<RequestOutcome> {
  const backoffBase = opts.backoffMs ?? 200;
  let outcome: RequestOutcome = { ok: false, attempts: 0 };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, opts.timeoutMs, opts.fetchImpl);
      if (!res.ok) {
        outcome = { ok: false, status: res.status, attempts: attempt };
        if ([400, 401, 403, 404, 429].includes(res.status) || attempt === opts.maxAttempts) {
          return outcome;
        }
      } else {
        return { ok: true, status: res.status, attempts: attempt, response: res };
      }
    } catch (error) {
      outcome = {
        ok: false,
        attempts: attempt,
        timedOut: error instanceof Error && error.name === "AbortError",
      };
      if (attempt === opts.maxAttempts) return outcome;
    }
    if (attempt < opts.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, backoffBase * attempt));
    }
  }

  return outcome;
}

function safeError(code: string): { code: string; message: string } {
  return { code, message: "Live exchange rates aren't available right now. Please try again shortly." };
}

function statusToError(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: "currency_auth_failed", message: "Live exchange rates couldn't be authenticated. Please try again later." };
  }
  if (status === 404) {
    return { code: "currency_pair_not_found", message: "That currency pair isn't supported by the live service." };
  }
  if (status === 429) {
    return { code: "currency_rate_limited", message: "Live exchange rates are temporarily busy. Try again in a minute." };
  }
  return safeError("currency_upstream_error");
}

function formatMoney(value: number, maxFractionDigits: number): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

function utcLabel(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Fetches a live rate for `from -> to` and computes `amount` in `to`.
 * Never throws; never invents rates; always returns a structured result.
 */
export async function fetchRealtimeCurrency(input: CurrencyToolInput): Promise<CurrencyToolOutput> {
  const key = process.env.EXCHANGE_RATE_API_KEY?.trim();
  if (!key) {
    return {
      success: false,
      error: {
        code: "currency_not_configured",
        message: "Live exchange rates aren't configured on this server yet.",
      },
      details: { configured: false },
    };
  }

  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (!from || !to) {
    return {
      success: false,
      error: {
        code: "currency_pair_required",
        message: "Please give me a clear currency pair, for example \u201C100 USD to EUR\u201D.",
      },
      details: {},
    };
  }
  const amount = Number.isFinite(input.amount) ? input.amount : 1;

  const cacheKey = `realtime:currency:${input.userId ?? "anon"}:${from}:${to}`;
  const cached = currencyCache.get(cacheKey);
  if (cached) {
    const converted = formatMoney(cached.rate * amount, 2);
    const answer = `${formatMoney(amount, 2)} ${from} = ${converted} ${to} (rate 1 ${from} = ${formatMoney(cached.rate, 6)} ${to}). Live data · updated ${utcLabel(cached.fetchedAtIso)}.`;
    return { success: true, answer, details: { ...cached.details, cached: true, amount, converted } };
  }

  const url = `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/pair/${from}/${to}`;

  try {
    const outcome = await dedupeInFlight(cacheKey, () =>
      requestWithRetry(url, {
        timeoutMs: input.timeoutMs ?? CURRENCY_TIMEOUT_MS,
        maxAttempts: input.maxAttempts ?? CURRENCY_MAX_ATTEMPTS,
        fetchImpl: input.fetchImpl,
        backoffMs: input.backoffMs ?? 200,
      })
    );

    if (!outcome.ok) {
      const base = { attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut) };
      if (typeof outcome.status === "number") {
        const mapped = statusToError(outcome.status);
        return { success: false, error: mapped, details: { ...base, status: outcome.status } };
      }
      return { success: false, error: safeError("currency_timeout_or_unreachable"), details: base };
    }

    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await outcome.response?.json();
      payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }

    const rate = payload?.conversion_rate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return { success: false, error: safeError("currency_malformed"), details: { attempts: outcome.attempts } };
    }

    const converted = formatMoney(rate * amount, 2);
    const answer = `${formatMoney(amount, 2)} ${from} = ${converted} ${to} (rate 1 ${from} = ${formatMoney(rate, 6)} ${to}). Live data · updated ${utcLabel(new Date().toISOString())}.`;
    const fetchedAt = new Date().toISOString();

    const details: Record<string, unknown> = {
      from,
      to,
      rate,
      amount,
      converted: rate * amount,
      attempts: outcome.attempts,
      provider: "exchangerate-api",
      fetchedAtIso: fetchedAt,
    };
    currencyCache.set(cacheKey, { answer, from, to, rate, fetchedAtIso: fetchedAt, details });
    return { success: true, answer, details };
  } catch {
    // Absorb any unexpected failure so the caller always gets a structured result.
    return { success: false, error: safeError("currency_error"), details: {} };
  }
}