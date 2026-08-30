# Phase 6F — Advanced Memory: Final Report

Secure, privacy-conscious typed memory layered onto the existing Spidey Bot
architecture (extends the Phase 4A `public.memories` table + `/memory` UI —
no parallel stack).

---

## 1. What was built

- **7-value typed taxonomy** — `preference | profile | project | workflow |
  instruction | fact | goal`, plus `source` (explicit/inferred) and
  `confidence` (high/medium/low) on every row.
- **Deterministic memory commands** — `MEMORY_SAVE / UPDATE / DELETE /
  LIST / DISABLE / ENABLE / NONE`, pure regex/math, no LLM for the command
  layer. Handled before the normal 6B pipeline (never reach image/realtime/
  document branches).
- **Centralized policy** — ALLOW / DENY / ASK / UPDATE_EXISTING with
  precedence: system safety > current request > explicit constraints > stored
  memory > inferred. The current request is never overridden by a stored
  preference; secrets are never stored, never echoed.
- **RLS-scoped persistence** — store functions never accept or write a
  `user_id`; ownership is derived from the authenticated session
  (`auth.uid()`), so a foreign row simply doesn't match instead of leaking or
  mutating.
- **Relevance-bounded retrieval** — top-10, deterministic ranking (keyword,
  type-topic, source explicitness, confidence, importance, recency), enabled
  only, compact identity-free context block with a char budget and leak-free
  summary.
- **Dedup by stable keys** (`preference:response_language`) with explicit-over-
  inferred merge rules.
- **Master switch** — `profiles.memory_enabled`, exposed via
  `GET/PATCH /api/memories/state` and a Pause/Resume control in the UI.
- **Secret veto + safe logging** — credential label/value patterns (incl.
  `API_KEY=abc`), clause-level redaction, PEM block redaction, high-entropy
  guard; **render-time defense** (escaping) and delete authorization checks.

### Files

- Migration: `supabase/migrations/20260829000000_phase6f_memory_type_system.sql`
- Module: `src/lib/memory/` — `types / security / intent / policy / extractor /
  store / retrieval / context / index`
- Wiring: `src/app/api/chat/route.ts`, `src/app/api/memories/route.ts`,
  `src/app/api/memories/state/route.ts`, `src/app/api/memories/[id]/route.ts`
- UI: `src/types/index.ts`, `src/hooks/use-memories.ts`,
  `src/components/memory/memory-board.tsx`, `src/app/(app)/memory/page.tsx`
- Tests: `test-phase6f.ts`, `test-phase6f-security.ts`
- Live probe: `_probe-6f-live.ts`

---

## 2. AUTOMATED — DONE

All 16 suites green in the full regression sweep, including the two new
Phase 6F suites:

| Suite | Assertions |
| --- | --- |
| `test-phase6f.ts` (intent/extraction/policy/store/retrieval/context/E2E) | 159 |
| `test-phase6f-security.ts` (secrets/logging/policy/render defense/authz/resilience) | 97 |
| `test-phase6e.ts` | 160 |
| `test-phase6d.ts` / `-hf` | 147 / 103 |
| `test-phase6c.ts` / `-hf` | 164 / 67 |
| `test-phase6b.ts` | 311 |
| `test-phase6a.ts` | 224 |
| `test-phase5f/g/h.ts` | 54 / reliability / 13 |
| `test-5e2-final.ts` / `-multimodal.ts` | 69 / 84 |
| `test-structural-fix.ts` / `test-visual-processing.ts` | 80 / 114 |

Toolchain checks (all clean):

- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors (only pre-existing warnings in unrelated files)
- `npm run build` — COMPILED, EXIT=0 (includes `/api/memories/state`)

---

## 3. LIVE — PENDING

`_probe-6f-live.ts` drives the real 6F persistence service against a
Supabase project under the same anon-client + RLS boundary the app relies on
(create → same-key merge → list visibility → patch → resolveDeleteTarget →
delete-own → secret veto), never printing credentials or other users' memory.

Current honest status:

```
[probe] supabase url present=true publishable key present=true probe account present=false
[probe] RESULT PENDING — probe account or Supabase env missing
```

Supabase env exists, but there is no probe credential to run the lifecycle
under an authenticated session (RLS inserts require `auth.uid()` non-null).

To reach LIVE=OK: add a throwaway account to `.env.local`
(`PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD`) and re-run
`npx tsx _probe-6f-live.ts`.

Migration still needs to be applied to the project for the typed columns and
`profiles.memory_enabled`:
`supabase migration up` (or `db push`) with the file above.

---

## 4. BROWSER — PENDING (manual checklist)

Not exercised in a browser yet. When you wish to verify in the UI:

1. `npm run dev`, log in, open `/memory`
2. Type a memory, confirm the type badge, explicit source, Pause/Resume banner
3. Pause → UI shows the amber banner and disables add/edit/delete actions
4. Save a credential-like string (e.g. `API_KEY=abc…`) → veto toast, nothing stored
5. In `/chat`: `remember …`, `list your memories`, `forget …`, `don't forget …`,
   `turn memory off/on` — confirm deterministic replies and no memory command
   ever reaches the image/realtime/document branches
6. Ask a chat question that matches a stored typed memory and confirm the
   compact context block is injected but ids/timestamps/secrets never appear

---

## 5. PHASE 6F STATUS:

- **AUTOMATED**: DONE — 159 + 97 new assertions green; all 16 suites green;
  tsc/lint/build clean.
- **LIVE**: PENDING — needs `PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD` in
  `.env.local` and the migration applied to the project.
- **BROWSER**: PENDING — manual checklist in section 4.