// ---------------------------------------------------------------------------
// Automated tests for Phase 5F Performance + Caching.
// Run with: npx tsx test-phase5f.ts
//
// TEST 1  — LRU_SET_GET: basic set/get returns correct value
// TEST 2  — LRU_TTL_EXPIRY: expired entries return undefined
// TEST 3  — LRU_EVICTS_OLDEST: exceeds maxSize, oldest entries evicted
// TEST 4  — LRU_REFRESH_ON_GET: get refreshes LRU position
// TEST 5  — LRU_DELETE: explicit delete removes entry
// TEST 6  — LRU_PRUNE: removes expired entries, returns count
// TEST 7  — LRU_CUSTOM_TTL: per-entry TTL overrides default
// TEST 8  — DEDUPE_IN_FLIGHT: concurrent calls share same promise
// TEST 9  — DEDUPE_IN_FLIGHT_SEQUENTIAL: second call starts fresh
// TEST 10 — DEDUPE_IN_FLIGHT_FAILURE: failed op cleans up for next call
// TEST 11 — REQUEST_SCOPE_DEDUP: scope dedupes by key
// TEST 12 — REQUEST_SCOPE_INDEPENDENT: different keys are independent
// TEST 13 — REQUEST_SCOPE_CLEAR: clear resets scope
// TEST 14 — TIMING_ACCUMULATOR: start/end records durations
// TEST 15 — TIMING_ACCUMULATOR_RECORD: manual record works
// TEST 16 — TIMING_ACCUMULATOR_FLUSH: flush clears and logs
// TEST 17 — QUERY_ANALYSIS_CACHE_HIT: second call returns cached
// TEST 18 — QUERY_ANALYSIS_CACHE_MISS: different queries are separate
// TEST 19 — VISUAL_ASSET_CACHE_HIT: same key returns cached
// TEST 20 — VISUAL_ASSET_CACHE_DIFFERENT_USER: different users are isolated
// TEST 21 — DOCUMENT_STATUS_CACHE: status cached and invalidated
// TEST 22 — INFLIGHT_SIZE_TRACKING: getInFlightSize tracks active ops
// TEST 23 — LRU_OVERWRITE: setting same key updates value
// TEST 24 — CACHE_CROSS_USER_ISOLATION: user A cache doesn't leak to user B
// ---------------------------------------------------------------------------

import {
  LRU,
  dedupeInFlight,
  getInFlightSize,
  createRequestScope,
  TimingAccumulator,
  queryAnalysisCache,
  visualAssetCache,
  documentStatusCache,
} from "./src/lib/cache";

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

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
  // ===========================================================================
  // TEST 1 — LRU_SET_GET
  // ===========================================================================
  console.log("\nTEST 1 — LRU_SET_GET");
  {
    const cache = new LRU<string, number>(10, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    assertEqual(cache.get("a"), 1, "get a = 1");
    assertEqual(cache.get("b"), 2, "get b = 2");
    assertEqual(cache.size, 2, "size = 2");
  }

  // ===========================================================================
  // TEST 2 — LRU_TTL_EXPIRY
  // ===========================================================================
  console.log("\nTEST 2 — LRU_TTL_EXPIRY");
  {
    const cache = new LRU<string, number>(10, 1); // 1ms TTL
    cache.set("a", 1);
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    assertEqual(cache.get("a"), undefined, "expired entry returns undefined");
    assertEqual(cache.size, 0, "expired entry removed from map");
  }

  // ===========================================================================
  // TEST 3 — LRU_EVICTS_OLDEST
  // ===========================================================================
  console.log("\nTEST 3 — LRU_EVICTS_OLDEST");
  {
    const cache = new LRU<string, number>(3, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // should evict "a"
    assertEqual(cache.get("a"), undefined, "a evicted");
    assertEqual(cache.get("b"), 2, "b still present");
    assertEqual(cache.get("d"), 4, "d present");
    assertEqual(cache.size, 3, "size capped at 3");
  }

  // ===========================================================================
  // TEST 4 — LRU_REFRESH_ON_GET
  // ===========================================================================
  console.log("\nTEST 4 — LRU_REFRESH_ON_GET");
  {
    const cache = new LRU<string, number>(3, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" to refresh it
    cache.get("a");
    cache.set("d", 4); // should evict "b" (least recently used)
    assertEqual(cache.get("a"), 1, "a still present after refresh");
    assertEqual(cache.get("b"), undefined, "b evicted (was least recently used)");
    assertEqual(cache.get("d"), 4, "d present");
  }

  // ===========================================================================
  // TEST 5 — LRU_DELETE
  // ===========================================================================
  console.log("\nTEST 5 — LRU_DELETE");
  {
    const cache = new LRU<string, number>(10, 60_000);
    cache.set("a", 1);
    cache.delete("a");
    assertEqual(cache.get("a"), undefined, "deleted entry returns undefined");
    assertEqual(cache.size, 0, "size decreased");
  }

  // ===========================================================================
  // TEST 6 — LRU_PRUNE
  // ===========================================================================
  console.log("\nTEST 6 — LRU_PRUNE");
  {
    const cache = new LRU<string, number>(10, 1); // 1ms TTL
    cache.set("a", 1);
    cache.set("b", 2);
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    const removed = cache.prune();
    assertEqual(removed, 2, "pruned 2 expired entries");
    assertEqual(cache.size, 0, "cache empty after prune");
  }

  // ===========================================================================
  // TEST 7 — LRU_CUSTOM_TTL
  // ===========================================================================
  console.log("\nTEST 7 — LRU_CUSTOM_TTL");
  {
    const cache = new LRU<string, number>(10, 60_000); // default 60s
    cache.set("short", 1, 1); // 1ms custom TTL
    cache.set("long", 2); // 60s default TTL
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    assertEqual(cache.get("short"), undefined, "short TTL expired");
    assertEqual(cache.get("long"), 2, "long TTL still valid");
  }

  // ===========================================================================
  // TEST 8 — DEDUPE_IN_FLIGHT
  // ===========================================================================
  console.log("\nTEST 8 — DEDUPE_IN_FLIGHT");
  {
    let callCount = 0;
    const slowFn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };

    // Launch two concurrent calls with same key
    const [r1, r2] = await Promise.all([
      dedupeInFlight("test-key", slowFn),
      dedupeInFlight("test-key", slowFn),
    ]);

    assertEqual(r1, 42, "first call returns 42");
    assertEqual(r2, 42, "second call returns 42");
    assertEqual(callCount, 1, "function called only once");
  }

  // ===========================================================================
  // TEST 9 — DEDUPE_IN_FLIGHT_SEQUENTIAL
  // ===========================================================================
  console.log("\nTEST 9 — DEDUPE_IN_FLIGHT_SEQUENTIAL");
  {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return callCount;
    };

    const r1 = await dedupeInFlight("seq-key", fn);
    assertEqual(r1, 1, "first call = 1");

    const r2 = await dedupeInFlight("seq-key", fn);
    assertEqual(r2, 2, "second call = 2 (fresh after first completed)");
    assertEqual(callCount, 2, "function called twice");
  }

  // ===========================================================================
  // TEST 10 — DEDUPE_IN_FLIGHT_FAILURE
  // ===========================================================================
  console.log("\nTEST 10 — DEDUPE_IN_FLIGHT_FAILURE");
  {
    let callCount = 0;
    const failingFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      return "recovered";
    };

    try {
      await dedupeInFlight("fail-key", failingFn);
    } catch {
      // expected
    }

    const r2 = await dedupeInFlight("fail-key", failingFn);
    assertEqual(r2, "recovered", "second call succeeds after first failure");
  }

  // ===========================================================================
  // TEST 11 — REQUEST_SCOPE_DEDUP
  // ===========================================================================
  console.log("\nTEST 11 — REQUEST_SCOPE_DEDUP");
  {
    const scope = createRequestScope();
    let callCount = 0;

    const fn = async () => {
      callCount++;
      return "result";
    };

    const r1 = await scope.dedupe("key", fn);
    const r2 = await scope.dedupe("key", fn);

    assertEqual(r1, "result", "first call returns result");
    assertEqual(r2, "result", "second call returns same result");
    assertEqual(callCount, 1, "function called only once");
  }

  // ===========================================================================
  // TEST 12 — REQUEST_SCOPE_INDEPENDENT
  // ===========================================================================
  console.log("\nTEST 12 — REQUEST_SCOPE_INDEPENDENT");
  {
    const scope = createRequestScope();
    let countA = 0;
    let countB = 0;

    await scope.dedupe("a", async () => { countA++; return "a"; });
    await scope.dedupe("b", async () => { countB++; return "b"; });

    assertEqual(countA, 1, "key a called once");
    assertEqual(countB, 1, "key b called once");
    assert(scope.has("a"), "scope has key a");
    assert(scope.has("b"), "scope has key b");
  }

  // ===========================================================================
  // TEST 13 — REQUEST_SCOPE_CLEAR
  // ===========================================================================
  console.log("\nTEST 13 — REQUEST_SCOPE_CLEAR");
  {
    const scope = createRequestScope();
    await scope.dedupe("key", async () => "val");
    assert(scope.has("key"), "scope has key before clear");
    scope.clear();
    assert(!scope.has("key"), "scope empty after clear");
  }

  // ===========================================================================
  // TEST 14 — TIMING_ACCUMULATOR
  // ===========================================================================
  console.log("\nTEST 14 — TIMING_ACCUMULATOR");
  {
    const timing = new TimingAccumulator();
    timing.start("op1");
    await new Promise((r) => setTimeout(r, 10));
    const ms = timing.end("op1");
    assert(ms >= 5, `op1 duration >= 5ms (got ${ms}ms)`);
  }

  // ===========================================================================
  // TEST 15 — TIMING_ACCUMULATOR_RECORD
  // ===========================================================================
  console.log("\nTEST 15 — TIMING_ACCUMULATOR_RECORD");
  {
    const timing = new TimingAccumulator();
    timing.record("manual", 42);
    // Should not throw
    timing.flush("test");
    assert(true, "flush after manual record did not throw");
  }

  // ===========================================================================
  // TEST 16 — TIMING_ACCUMULATOR_FLUSH
  // ===========================================================================
  console.log("\nTEST 16 — TIMING_ACCUMULATOR_FLUSH");
  {
    const timing = new TimingAccumulator();
    timing.record("a", 10);
    timing.record("b", 20);
    timing.flush("test");
    // After flush, internal state should be cleared (no error on second flush)
    timing.flush("test2");
    assert(true, "double flush did not throw");
  }

  // ===========================================================================
  // TEST 17 — QUERY_ANALYSIS_CACHE_HIT
  // ===========================================================================
  console.log("\nTEST 17 — QUERY_ANALYSIS_CACHE_HIT");
  {
    // Clear cache first
    queryAnalysisCache.prune();

    const q = "What is normalization?";
    queryAnalysisCache.set(q, { intent: "definition" });
    const cached = queryAnalysisCache.get(q) as { intent: string } | undefined;
    assertEqual(cached?.intent, "definition", "cached query analysis returned");
  }

  // ===========================================================================
  // TEST 18 — QUERY_ANALYSIS_CACHE_MISS
  // ===========================================================================
  console.log("\nTEST 18 — QUERY_ANALYSIS_CACHE_MISS");
  {
    const q1 = "query alpha";
    const q2 = "query beta";
    queryAnalysisCache.set(q1, { intent: "a" });
    queryAnalysisCache.set(q2, { intent: "b" });
    const r1 = queryAnalysisCache.get(q1) as { intent: string };
    const r2 = queryAnalysisCache.get(q2) as { intent: string };
    assertEqual(r1.intent, "a", "query alpha has intent a");
    assertEqual(r2.intent, "b", "query beta has intent b");
  }

  // ===========================================================================
  // TEST 19 — VISUAL_ASSET_CACHE_HIT
  // ===========================================================================
  console.log("\nTEST 19 — VISUAL_ASSET_CACHE_HIT");
  {
    const key = "user1:doc1";
    const assets = [{ assetType: "figure", pageNumber: 1 }];
    visualAssetCache.set(key, assets);
    const cached = visualAssetCache.get(key) as typeof assets;
    assertEqual(cached.length, 1, "cached visual asset returned");
    assertEqual(cached[0].assetType, "figure", "correct asset type");
  }

  // ===========================================================================
  // TEST 20 — VISUAL_ASSET_CACHE_DIFFERENT_USER
  // ===========================================================================
  console.log("\nTEST 20 — VISUAL_ASSET_CACHE_DIFFERENT_USER");
  {
    const keyA = "userA:doc1";
    const keyB = "userB:doc1";
    visualAssetCache.set(keyA, [{ assetType: "chart" }]);
    visualAssetCache.set(keyB, [{ assetType: "table" }]);

    const a = visualAssetCache.get(keyA) as Array<{ assetType: string }>;
    const b = visualAssetCache.get(keyB) as Array<{ assetType: string }>;
    assertEqual(a[0].assetType, "chart", "userA has chart");
    assertEqual(b[0].assetType, "table", "userB has table");
  }

  // ===========================================================================
  // TEST 21 — DOCUMENT_STATUS_CACHE
  // ===========================================================================
  console.log("\nTEST 21 — DOCUMENT_STATUS_CACHE");
  {
    const key = "user1:doc-abc";
    documentStatusCache.set(key, { status: "ready", extractedLength: 5000 });
    const cached = documentStatusCache.get(key);
    assertEqual(cached?.status, "ready", "cached status = ready");
    assertEqual(cached?.extractedLength, 5000, "cached length = 5000");

    // Invalidate
    documentStatusCache.delete(key);
    assertEqual(documentStatusCache.get(key), undefined, "cache invalidated");
  }

  // ===========================================================================
  // TEST 22 — INFLIGHT_SIZE_TRACKING
  // ===========================================================================
  console.log("\nTEST 22 — INFLIGHT_SIZE_TRACKING");
  {
    const initial = getInFlightSize();
    let resolve: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });

    dedupeInFlight("size-test", async () => {
      await blocker;
      return "done";
    });

    // Small delay to ensure the promise is registered
    await new Promise((r) => setTimeout(r, 5));
    assert(getInFlightSize() > initial, "in-flight size increased during pending op");

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    assertEqual(getInFlightSize(), initial, "in-flight size restored after completion");
  }

  // ===========================================================================
  // TEST 23 — LRU_OVERWRITE
  // ===========================================================================
  console.log("\nTEST 23 — LRU_OVERWRITE");
  {
    const cache = new LRU<string, number>(10, 60_000);
    cache.set("x", 1);
    cache.set("x", 2);
    assertEqual(cache.get("x"), 2, "overwritten value is 2");
    assertEqual(cache.size, 1, "size still 1 after overwrite");
  }

  // ===========================================================================
  // TEST 24 — CACHE_CROSS_USER_ISOLATION
  // ===========================================================================
  console.log("\nTEST 24 — CACHE_CROSS_USER_ISOLATION");
  {
    // Simulate per-user caching using userId-prefixed keys
    const userAKey = "userA:doc1";
    const userBKey = "userB:doc1";

    queryAnalysisCache.set(userAKey, { intent: "userA_intents" });
    queryAnalysisCache.set(userBKey, { intent: "userB_intents" });

    const a = queryAnalysisCache.get(userAKey) as { intent: string };
    const b = queryAnalysisCache.get(userBKey) as { intent: string };

    assertEqual(a.intent, "userA_intents", "user A sees own cached data");
    assertEqual(b.intent, "userB_intents", "user B sees own cached data");
    assert(a.intent !== b.intent, "users do not see each other's data");
  }

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Phase 5F Tests: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log(`${"=".repeat(60)}`);

  if (failed > 0) {
    process.exit(1);
  }
})();
