// ---------------------------------------------------------------------------
// Phase 5H — Final hardening tests.
// Run with: npx tsx test-phase5h.ts
//
// Covers reliability conditions uncovered by the Phase 5H audit that had no
// automated coverage:
//   TEST 1 — DOCUMENT_DELETE_VISUAL_ORPHANS: deleting a document must also
//            remove its visual asset storage objects (PDF page PNGs /
//            slide images) instead of leaving them orphaned.
//   TEST 2 — DOCUMENT_DELETE_NULL_PATHS: rows without a storage path are skipped.
//   TEST 3 — DOCUMENT_DELETE_NO_ASSETS: no assets -> no storage call.
//   TEST 4 — DOCUMENT_DELETE_REMOVE_FAILURE: storage remove failure is
//            best-effort (returns 0, never throws), so the document delete
//            is never blocked.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteDocumentVisualAssets,
  sanitizeFilename,
  buildStoragePath,
} from "./src/lib/documents";

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
    console.error(
      `  FAIL — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
    );
    failed++;
  }
}

interface MockSupabase {
  removeResult: { error: unknown };
  selectCall: { source: string; filters: Array<[string, string]> };
  removeCalls: string[][];
}

function makeMockSupabase(
  rows: Array<{ storage_path: string | null }>,
  removeError: unknown = null
): MockSupabase & Record<string, unknown> {
  const state: MockSupabase = {
    removeResult: { error: removeError },
    selectCall: { source: "visual_assets", filters: [] },
    removeCalls: [],
  };

  const from = (source: string) => ({
    select: () => {
      state.selectCall.source = source;
      const firstEq = (column: string, value: string) => {
        state.selectCall.filters.push([column, value]);
        const secondEq = (c2: string, v2: string) => {
          state.selectCall.filters.push([c2, v2]);
          return {
            data: rows,
            error: null,
          };
        };
        return { eq: secondEq };
      };
      return { eq: firstEq };
    },
  });

  return {
    ...state,
    from,
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          state.removeCalls.push(paths);
          return { data: null, error: state.removeResult.error };
        },
      }),
    },
  };
}

function asSupabase(mock: unknown): SupabaseClient {
  return mock as SupabaseClient;
}

(async () => {
  // ===========================================================================
  // TEST 1 — DOCUMENT_DELETE_VISUAL_ORPHANS
  // A document's visual assets live in storage under {user}/visual_assets/...;
  // the metadata rows cascade-delete, so the storage objects must be removed
  // explicitly when the document is deleted.
  // ===========================================================================
  console.log("\nTEST 1 — DOCUMENT_DELETE_VISUAL_ORPHANS");
  {
    const mock = makeMockSupabase([
      { storage_path: "u1/visual_assets/doc1/page_1.png" },
      { storage_path: "u1/visual_assets/doc1/page_2.png" },
    ]) as MockSupabase & Record<string, unknown>;

    const removed = await deleteDocumentVisualAssets(
      asSupabase(mock),
      "doc1",
      "u1"
    );

    assertEqual(removed, 2, "two storage objects removed");
    assert(
      mock.removeCalls.length === 1 &&
        mock.removeCalls[0].length === 2 &&
        mock.removeCalls[0][0] === "u1/visual_assets/doc1/page_1.png",
      "remove called once with both asset paths"
    );
    assert(
      mock.selectCall.filters.some(
        ([c, v]) => c === "document_id" && v === "doc1"
      ),
      "visual_assets scoped by document_id"
    );
    assert(
      mock.selectCall.filters.some(([c, v]) => c === "user_id" && v === "u1"),
      "visual_assets scoped by user_id"
    );
  }

  // ===========================================================================
  // TEST 2 — DOCUMENT_DELETE_NULL_PATHS
  // Null storage_path values (standalone assets not yet uploaded) must be
  // filtered out so Storage.remove only ever receives real paths.
  // ===========================================================================
  console.log("\nTEST 2 — DOCUMENT_DELETE_NULL_PATHS");
  {
    const mock = makeMockSupabase([
      { storage_path: "u1/visual_assets/doc1/page_1.png" },
      { storage_path: null },
    ]) as MockSupabase & Record<string, unknown>;

    const removed = await deleteDocumentVisualAssets(
      asSupabase(mock),
      "doc1",
      "u1"
    );

    assertEqual(removed, 1, "one real path removed");
    assert(
      mock.removeCalls.length === 1 && mock.removeCalls[0].length === 1,
      "only the non-null path passed to storage remove"
    );
  }

  // ===========================================================================
  // TEST 3 — DOCUMENT_DELETE_NO_ASSETS
  // No visual assets -> no storage objects -> remove must not be called.
  // ===========================================================================
  console.log("\nTEST 3 — DOCUMENT_DELETE_NO_ASSETS");
  {
    const mock = makeMockSupabase([]) as MockSupabase & Record<string, unknown>;

    const removed = await deleteDocumentVisualAssets(
      asSupabase(mock),
      "doc2",
      "u1"
    );

    assertEqual(removed, 0, "zero removed");
    assert(mock.removeCalls.length === 0, "storage remove never called");
  }

  // ===========================================================================
  // TEST 4 — DOCUMENT_DELETE_REMOVE_FAILURE
  // If the storage removal fails the helper reports 0 and never throws, so
  // the document row delete is never blocked by orphan cleanup.
  // ===========================================================================
  console.log("\nTEST 4 — DOCUMENT_DELETE_REMOVE_FAILURE");
  {
    const mock = makeMockSupabase(
      [{ storage_path: "u1/visual_assets/doc3/page_1.png" }],
      { message: "storage unavailable" }
    ) as MockSupabase & Record<string, unknown>;

    let threw = false;
    let removed = 0;
    try {
      removed = await deleteDocumentVisualAssets(asSupabase(mock), "doc3", "u1");
    } catch {
      threw = true;
    }

    assert(!threw, "no exception on storage remove failure");
    assertEqual(removed, 0, "reports 0 removed on failure");
  }

  // ===========================================================================
  // TEST 5 — FILENAME SANITIZATION (regression guard)
  // sanitizeFilename is exercised by document upload; guard against regressing
  // into path-traversal or control-character issues.
  // ===========================================================================
  console.log("\nTEST 5 — FILENAME SANITIZATION");
  {
    const safe = sanitizeFilename("../../etc/passwd");
    assert(safe !== "../../etc/passwd", "path traversal stripped");

    const control = sanitizeFilename("bad\x00\x1fname.pdf");
    assert(!control.includes("\x00") && !control.includes("\x1f"), "control chars stripped");

    const pathJoin = buildStoragePath("u1", "doc1", "../../evil.pdf");
    assert(
      !pathJoin.includes("..") && pathJoin === "u1/doc1/evil.pdf",
      "stored path cannot contain parent traversal"
    );
  }

  console.log("\n============================================================");
  console.log(`Phase 5H tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");

  process.exit(failed > 0 ? 1 : 0);
})();