# Phase 5H — Final Hardening Report

**Date:** 2026-08-28
**Scope:** Full reliability/security audit of the Spidey Bot document + RAG system
**Outcome:** **COMPLETE WITH MANUAL VALIDATION REQUIRED** — everything that can be verified statically and via the automated suites is green; live Supabase/Database/Gemini/browser behavior requires manual validation (list below).

---

## Executive summary

The Phase 3 → 5G architecture was audited end-to-end (supabase migrations + RLS, auth/proxy, document upload/processing, agent retrieval pipeline, Gemini streaming, caching, multimodal/visual evidence, input validation, secrets, observability). The system is already extraordinarily defensive: RLS is owner-scoped on every table with parent-ownership re-verification, all API routes authenticate first, all inputs are schema-validated and bounded, retrieval is fail-open with anti-hallucination grounding, streaming has a latency-budgeted model-chain retry policy, and document processing has stalled-job recovery.

**One real production issue was found and fixed**: deleting a document removed its main storage file and DB rows (chunks + `visual_assets` rows cascade), but never removed the **visual asset storage objects** (rendered PDF page PNGs, slide images) under `{user}/visual_assets/*`, leaving them orphaned in storage. Fixed with a small best-effort cleanup (details in "Files changed").

No other component was modified. No retests were weakened. No test was deleted.

---

## Audit findings

### 1. Real problem found & fixed — orphaned visual-asset storage on document delete

- **Evidence (static):** `src/app/api/documents/[id]/route.ts` (DELETE) removed only `documents.storage_path`. `visual_assets.document_id` is `ON DELETE CASCADE` (`supabase/migrations/20260826020000_phase5e1_visual_assets.sql:87`), so asset rows delete automatically — but their backing PNGs in the `documents` bucket (written by `renderPdfPages` at `src/lib/multimodal/pdf-page-renderer.ts:133`) were never removed. Deterministic, not hypothetical.
- **Fix:** new best-effort helper `deleteDocumentVisualAssets()` in `src/lib/documents.ts`, called from the DELETE route before the row delete. Mirrors the existing context-source delete cleanup pattern (`src/app/api/context-sources/[id]/route.ts`). Never blocks the document delete on storage failure (a leftover file is preferable to an undeletable document).
- **Dependency:** requires the `visual_assets` table (Phase 5E-1 migration). If that migration is not yet applied, the helper's select simply returns an empty result (fail-open).

### 2. Verified robust — no change made

| Area | Verdict |
|---|---|
| **RLS (all 12 migrations)** | Owner-scoped on every table (`auth.uid() = user_id`) incl. child tables re-verifying parent ownership (subjects, topics, sessions, chunks, asset types). Messages re-derive conversation ownership. Storage policies scope by first path segment = `auth.uid()`. |
| **Auth / middleware** | `src/proxy.ts` protects `/chat /study /documents` etc.; `getUser()` refresh in middleware; API routes reject anonymous callers before touching Gemini quota. |
| **Secrets** | Only `process.env.GEMINI_API_KEY` (server-side, cached client). Zero `NEXT_PUBLIC_GEMINI_*`, zero `SUPABASE_SERVICE_ROLE_KEY` references anywhere in `src/`. `.env.example` explicitly forbids the service-role key. |
| **Upload validation** | MIME whitelist + `isSupportedMimeType`, size cap (25 MB default, `MAX_DOCUMENT_SIZE_MB`), empty-file reject, name length, subject/topic ownership validation, storage-insert cleanup on failure, path-traversal-safe `sanitizeFilename`. |
| **Document processing** | Ownership check; in-flight dedup keyed `process:{docId}:{userId}`; stalled-job recovery (>5 min); bounded `waitForProcessing` (30×1 s); magic-byte MIME resolution; empty-file reject; FAILED status on error; PDF → pdfjs → Gemini OCR (inline ≤50 MB / File API) → minimal-text fallback; File API cleanup; best-effort page rendering (deterministic upsert paths — no accumulation on reprocess). |
| **Chat streaming** | Model chain (primary + 2 fallbacks, independent quota buckets), `MAX_ATTEMPTS=3`, `MAX_TOTAL_WAIT_MS=8000`, reads ahead to first text chunk (no silent empty streams), abort → 499, 429/503 → structured `rate_limited`, non-sensitive logging only. |
| **RAG / agent** | Rule-based deterministic routing; retrieve-then-ground with strict anti-hallucination instructions (incl. negative-results and no-results grounding); budget-aware multi-source orchestration (12k chars / 8 chunks) with cross-source reranking, conflict detection, dedup; visual evidence bounded (4 assets, 20 MB each), never throws. |
| **Caching (Phase 5F)** | Bounded LRU + TTL. User IDs embedded in keys (`{userId}:{docId}`). Litmus: `queryAnalysisCache` is keyed by query text only, but it stores pure text analysis (no per-user data) — verified no information leak. |
| **Input validation** | Zod everywhere (`chatRequestSchema`: role enum, ≤8000 chars, ≤40 messages, uuid context ids); UUID regex; pagination bounded (≤50 docs, ≤100 sources); Response bodies whitelisted. |
| **Observability** | Timings/counters only; no prompt content, no credentials, no document contents in logs. |

### 3. Residual risks (manual validation required)

- **No live DB checked:** migration/trigger/policy state on the real Supabase project could not be verified (no database connection from the CLI). All SQL was inspected; apply/verify via the existing `supabase/verification-*.sql` scripts.
- **Gemini live behavior** (model names `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, OCR model) and **real browser UI flows** were not exercised end-to-end here.
- **Residual orphan edges:** storage objects created by a PDF render whose `visual_assets` insert failed (file uploaded, row missing) are unreferenced and only DB-deletable paths are cleaned; these are rare and not enumerable per-document. Row-level cleanup now covers the deterministic case.

---

## Test results (this session, run via `npx tsx <suite>.ts`)

| Suite | Result |
|---|---|
| `test-phase5h.ts` (NEW hardening) | **13 / 13 passed** |
| `test-phase5g.ts` (RAG + reliability, 93 result rows) | **all passed** |
| `test-phase5f.ts` (caching) | **54 / 54 passed** |
| `test-5e2-final.ts` (multimodal repair) | **69 / 69 passed** |
| `test-structural-fix.ts` (structural retrieval) | **80 / 80 passed** |
| `test-5e2-multimodal.ts` | **84 / 84 passed** |
| `test-visual-processing.ts` | **114 / 114 passed** |
| `diag-qa.ts` | observational diagnostic — ran clean (no assert contract) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors; 11 pre-existing warnings (unused vars in eval/test scaffolding) — none from changed files |
| `npm run build` | production build succeeds, all routes compiled |

No dedicated 5A–5D / 5E-1 suite files exist in the repo; those phases are covered by the 5E-2/5F/5G suites above plus the batch validation.

---

## Files changed (complete list)

- `src/lib/documents.ts` — added `deleteDocumentVisualAssets(supabase, documentId, userId)` best-effort helper (+ `SupabaseClient` type import).
- `src/app/api/documents/[id]/route.ts` — DELETE calls the helper before removing the main file, so visual-asset storage objects no longer orphan.
- `test-phase5h.ts` (new) — 13 assertions: orphan-on-delete interaction tests (paths removed, scoped by document+user, null paths skipped, no assets → no call, storage failure → best-effort), plus a filename-sanitization regression guard.

All other files were audited and left unchanged.

---

## Manual validation checklist (DATABASE MIGRATION REQUIRED)

1. Confirm every migration under `supabase/migrations/` is applied with no errors, then run each `supabase/verification-*.sql` (phase3, 4a–4d, 5a/5b, 5e1) and confirm expected rows/policies.
2. Confirm the `documents` storage bucket is private and storage policies exist on `storage.objects` for `{user_id}/*`.
3. Real Gemini round-trip: upload a PDF → chat → verify text retrieval + streaming + Stop button (499) + a 429-style structured error path.
4. Delete a document with rendered pages in a test account, then confirm no objects remain under `{user}/visual_assets/`.
5. Browser smoke test of /chat, /documents, /study, /productivity, /memory against the live app.

---

## Final status

**PHASE 5 COMPLETE — COMPLETE WITH MANUAL VALIDATION REQUIRED.**

Automated verification, typecheck, lint, and production build are all green after applying exactly one smallest-safe fix. No functional architecture was rewritten.