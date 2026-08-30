// ---------------------------------------------------------------------------
// Performance cache layer — Phase 5F
// Two-tier caching: L1 request-local dedup (per-request Map, auto-cleanup),
// L2 bounded LRU server-process cache with TTL.
// No Redis. No external infrastructure. Never returns stale cross-user data.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L2: Bounded LRU server-process cache
// ---------------------------------------------------------------------------

interface L2Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded LRU cache with TTL. Lives for the server process lifetime.
 * Evicts least-recently-used entries when max size is reached.
 * Entries expire after their TTL elapses.
 */
export class LRU<K, V> {
  private map = new Map<K, L2Entry<V>>();
  private maxSize: number;
  private defaultTtlMs: number;

  constructor(maxSize: number, defaultTtlMs: number) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    // Delete first to refresh position if key already exists
    this.map.delete(key);
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Delete a specific key. */
  delete(key: K): void {
    this.map.delete(key);
  }

  /** Remove all expired entries. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// L2 singleton caches
// ---------------------------------------------------------------------------

/** Query analysis cache: query string → QueryAnalysis. TTL 5 min. Max 500 entries. */
export const queryAnalysisCache = new LRU<string, unknown>(500, 5 * 60 * 1000);

/** Visual asset metadata cache: `${userId}:${docId}` → VisualAssetInfo[]. TTL 2 min. Max 200 entries. */
export const visualAssetCache = new LRU<string, unknown>(200, 2 * 60 * 1000);

/** Document status cache: `${userId}:${docId}` → { status, extractedLength }. TTL 30s. Max 100 entries. */
export const documentStatusCache = new LRU<string, { status: string; extractedLength: number | null }>(100, 30_000);

// ---------------------------------------------------------------------------
// In-flight deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicates concurrent async operations for the same key.
 * If operation for `key` is already in flight, returns the same Promise.
 * Otherwise starts the operation and stores the Promise for others to share.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function dedupeInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export function getInFlightSize(): number {
  return inFlight.size;
}

// ---------------------------------------------------------------------------
// Request-local scope (L1)
// ---------------------------------------------------------------------------

/**
 * Creates a per-request dedup scope. All calls within the scope that share
 * the same key will only execute the factory once.
 *
 * Usage:
 * ```
 * const scope = createRequestScope();
 * const analysis = await scope.dedupe("query-analysis", () => analyzeQuery(query));
 * ```
 */
export function createRequestScope() {
  const seen = new Map<string, Promise<unknown>>();

  return {
    async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = seen.get(key);
      if (existing) return existing as Promise<T>;
      const promise = fn();
      seen.set(key, promise);
      return promise;
    },
    has(key: string): boolean {
      return seen.has(key);
    },
    clear(): void {
      seen.clear();
    },
  };
}

export type RequestScope = ReturnType<typeof createRequestScope>;

// ---------------------------------------------------------------------------
// Performance timing helpers
// ---------------------------------------------------------------------------

/**
 * Timing accumulator for observability. Collects labeled durations
 * within a request and can be flushed as a single log line.
 */
export class TimingAccumulator {
  private marks = new Map<string, number>();
  private durations = new Map<string, number>();

  start(label: string): void {
    this.marks.set(label, performance.now());
  }

  end(label: string): number {
    const start = this.marks.get(label);
    if (start === undefined) return 0;
    const duration = Math.round(performance.now() - start);
    this.durations.set(label, duration);
    this.marks.delete(label);
    return duration;
  }

  record(label: string, durationMs: number): void {
    this.durations.set(label, durationMs);
  }

  flush(prefix: string): void {
    if (this.durations.size === 0) return;
    const parts: string[] = [];
    for (const [label, ms] of this.durations) {
      parts.push(`${label}=${ms}ms`);
    }
    console.log(`[perf/${prefix}] ${parts.join(" ")}`);
    this.durations.clear();
    this.marks.clear();
  }
}
