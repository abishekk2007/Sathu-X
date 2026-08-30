# Phase 6G — Tasks + Planning: Final Report

Deterministic, session-owned tasks & study plans layered onto the existing
Spidey Bot architecture (new tables `public.tasks` / `public.plans` /
`public.plan_steps` — no parallel stack, no memory coupling).

---

## 1. What was built

- **RLS-scoped persistence** — store functions never accept or write a
  `user_id`; ownership is derived exclusively from `auth.uid()` through the
  server client. `plan_steps` policies re-verify BOTH plan and task ownership,
  so a step can never attach a foreign row.
- **Deterministic task intents** — `detectTaskCommand` returns
  `TASK_CREATE / COMPLETE / UPDATE / CANCEL / DELETE / RESCHEDULE / LIST /
  NONE` (pure regex/math, no LLM). Ordinary statements ("I have an exam
  tomorrow", "I should write a plan soon") are deliberately NOT tasks; document
  words alone never hijack tasks. Task commands short-circuit BEFORE the
  Gemini key guard and the whole 6B pipeline.
- **Deterministic plan intents** — `detectPlanCommand` returns `PLAN_CREATE /
  NONE`, guarded so "we need to make a study plan" stays a normal statement
  while "create a study plan for my physics exam" and "can you make a study
  plan for physics" create.
- **Transactions with explicit legality** — tasks `pending → in_progress →
  completed/cancelled/failed` with an app-side transition table; plans
  `active → completed/cancelled`; steps `pending → in_progress →
  completed/cancelled` (no failed state exists for steps). Forbidden
  transitions throw a deterministic allowed-list error instead of silently
  mutating.
- **Dependency-aware plans** — steps keep `position` + `dependsOn` (sibling
  row UUIDs, resolved from 1-based `dependsOnPositions` by a post-insert
  update inside `createPlan`, cycle-checked app-side). The Phase 4C planner is
  reused; its reasoning never claims any step is done.
- **Injection/ownership fences** — `isUuidLike` gates every id-taking
  function; `validateTitle`/`validateTaskDescription`/
  `normalizeMetadata` bound text length and metadata size (500-byte budget);
  `assertOwnIncoming` re-derives ownership through `listPlans`/`getTask`
  instead of trusting client ids; `assertSafeTextField` / `assertSqlSafeBound`
  refuse SQL-break characters and interpolated values.
- **Honest messaging** — task completions are read back (through
  `findTaskByTitle` with exact → startsWith → includes precedence, skipping
  completed/cancelled for fuzzy matches) so replies always reflect what was
  actually stored; unsupported runner pulls are refused truthfully
  (`NO_PUSH_NOTE`); unresolvable due phrases resolve to `dueAt:null` rather
  than a guessed time.
- **Due resolution** — day-without-clock → end of the LOCAL day (23:59);
  relative windows ("in 3 days") are instant math preserving the wall clock
  (`hasExactTime:false`); clock phrases are exact ('tomorrow at 9am' IST →
  `2026-08-30T03:30:00.000Z`, verified).
- **6B extent point** — `EXTENSION_POINTS.TASK` is now true; the router
  ladder gains branch (6b) sitting BELOW image/document/follow-up and ABOVE
  domain/single-realtime (priority ladder order preserved verbatim).

### Files

- Migration: `supabase/migrations/20260829120000_phase6g_tasks_planning.sql`
- Module: `src/lib/tasks/` — `types / validation / schedule / security /
  intent / store / chat-handler / index`; `src/lib/planning/` — `planner /
  context / index`
- Wiring: `src/lib/agent/query-router.ts` (6b branch),
  `src/app/api/chat/route.ts` (short-circuit)
- API: `/api/tasks`, `/api/tasks/[id]`, `/api/plans`,
  `/api/plans/[id]`, `/api/plans/[id]/steps`, `/api/plans/[id]/steps/[stepId]`
- UI: `src/hooks/use-tasks.ts`, `src/hooks/use-plans.ts`,
  `src/components/tasks/tasks-board.tsx`,
  `src/components/plans-board.tsx`, `src/app/(app)/plans/page.tsx`,
  nav entry, chat timezone passing
- Tests: `test-phase6g.ts`, `test-phase6g-security.ts`
- Live probe: `_probe-6g-live.ts`

---

## 2. AUTOMATED — DONE

Full regression sweep — all 17 suites green:

| Suite | Assertions |
| --- | --- |
| `test-phase6g.ts` (intent matrix, due resolution, validation+security, plan engine, task store, plan+step store, chat E2E) | 218 |
| `test-phase6g-security.ts` (transition matrix, ownership by construction, payload/injection fences, uuid gates, authz fail-open, chat honesty) | 109 |
| `test-phase6f.ts` / `test-phase6f-security.ts` | 159 / 97 |
| `test-phase6e.ts` | 160 |
| `test-phase6d.ts` / `-hf` | 147 / 103 |
| `test-phase6c.ts` / `-hf` | 164 / 67 |
| `test-phase6b.ts` (incl. G7 — `EXTENSION_POINTS.TASK` activated) | 312 |
| `test-phase6a.ts` | 224 |
| `test-phase5f/g/h.ts` | 54 / reliability / 13 |
| `test-5e2-final.ts` / `-multimodal.ts` | 69 / 84 |
| `test-structural-fix.ts` / `test-visual-processing.ts` | 80 / 114 |

Toolchain checks (all clean):

- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors (only pre-existing warnings in unrelated files)
- `npm run build` — COMPILED, EXIT=0 (includes `/api/tasks*`, `/api/plans*`,
  `/plans`, `/tasks`)

---

## 3. LIVE — PENDING

`_probe-6g-live.ts` drives the real 6G persistence service against a Supabase
project under the same anon-client + RLS boundary the app relies on (task
create → list visibility → complete → reschedule → delete, plan + steps with
dependency resolution → step status → plan delete, PLUS an anonymous-client
write/list that must be fully rejected — proving RLS binds ownership),
never printing credentials or other users' rows.

Current honest status:

```
[probe] supabase url present=true publishable key present=true probe account present=false
[probe] RESULT PENDING — probe account or Supabase env missing
```

Supabase env exists, but there is no probe credential to run the lifecycle
under an authenticated session (RLS inserts require `auth.uid()` non-null).

To reach LIVE=OK: add a throwaway account to `.env.local`
(`PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD`), apply the migration
(`supabase migration up` / `db push` for
`supabase/migrations/20260829120000_phase6g_tasks_planning.sql`), and re-run
`npx tsx _probe-6g-live.ts`.

---

## 4. BROWSER — PENDING (manual checklist)

Not exercised in a browser yet. When you wish to verify in the UI:

1. `npm run dev`, log in, open `/tasks` and `/plans`
2. In `/tasks`: add a task (title/priority/due/tags), complete it, filter by
   status, reschedule, delete — confirm the board reflects server state and
   rows persist after reload
3. In `/plans`: create a plan from the Phase 4C planner flow, see ordered
   dependency-aware steps, mark steps in progress/completed
4. In `/chat`: `add a task: finish physics notes`, `mark the reminder laundry
   as done`, `delete the task old notes`, `reschedule <task> to tomorrow at
   9am`, `show my tasks` — confirm deterministic replies, read-back honesty,
   and that task/plan commands never reach the image/realtime/document
   branches (no Gemini key needed)
5. Confirm ordinary statements ("I have an exam tomorrow") and document words
   alone ("finish reading my pdf notes") do NOT become tasks
6. Confirm task/plan rows NEVER appear in `/memory` and memories never feed
   tasks (no cross-writes)

---

## 5. PHASE 6G STATUS:

- **AUTOMATED**: DONE — 218 + 109 new assertions green; all 17 suites green;
  tsc/lint/build clean.
- **LIVE**: PENDING — needs `PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD` in
  `.env.local` and the 6G migration applied to the project.
- **BROWSER**: PENDING — manual checklist in section 4.