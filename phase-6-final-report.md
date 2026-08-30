# Phase 6 — Data Services: Final Report

Six consecutive sub-phases (6A–6G) added real data services to Spidey Bot:
auth + personas, session-aware routing, images + HF models, documents +
embeddings (RAG), memories + realtime advisories, the typed memory system,
and finally tasks + planning. Every piece shares the same discipline:
RLS-scoped ownership via `auth.uid()`, deterministic command layers ahead of
the Gemini pipeline, honest three-tier verification (AUTOMATED / LIVE /
BROWSER), and no parallel stacks.

---

## 1. Sub-phase summaries

- **6A Auth + Personas** — Supabase auth, timezone-aware wall-clock utilities,
  persona layering on `profiles`, RLS binding for all later phases.
  Migration `20260828200000_phase6a_auth_personas.sql`.
- **6B Router** — the subsystem router with a strict priority ladder and
  extension points; later phases slot in BELOW image/document/follow-up and
  ABOVE domain/realtime, preserving the ladder verbatim.
- **6C Images** — deterministic image intent + HF model router
  (`HF_IMAGE_MODEL`), generation/editing routes, history.
- **6D Documents** — deterministic doc intent, text extraction, embeddings,
  chunking, `public.documents` + `document_chunks` with RLS and vector index.
- **6E Memories + Realtime** — typed memory foundations, realtime
  study advisories, note-taking + `NO_PUSH` refusal honesty.
- **6F Memory type system** — 7-value typed taxonomy, deterministic
  memory commands, centralized ALLOW/DENY policy, secret veto, master switch,
  relevance-bounded retrieval. Migration
  `20260829000000_phase6f_memory_type_system.sql`.
- **6G Tasks + Planning** — `public.tasks` / `public.plans` /
  `public.plan_steps` with RLS and dependency-aware steps; deterministic
  task/plan commands short-circuiting before Gemini; API + full UI (`/tasks`,
  `/plans`). Migration
  `20260829120000_phase6g_tasks_planning.sql`.

---

## 2. AUTOMATED — DONE

All 17 suites green in the final full-regression sweep:

| Suite | Assertions |
| --- | --- |
| 6G tasks+planning `test-phase6g.ts` / `-security.ts` | 218 / 109 |
| 6F memory type system `test-phase6f.ts` / `-security.ts` | 159 / 97 |
| 6E memories+realtime `test-phase6e.ts` | 160 |
| 6D documents `test-phase6d.ts` / `-hf.ts` | 147 / 103 |
| 6C images `test-phase6c.ts` / `-hf.ts` | 164 / 67 |
| 6B router `test-phase6b.ts` (incl. G7 extension point) | 312 |
| 6A auth/personas `test-phase6a.ts` | 224 |
| 5E–5H retrieval/workflow suites | 54 / reliability / 13 / 69 / 84 / 80 / 114 |

Toolchain (all clean):

- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors (only pre-existing warnings in unrelated files)
- `npm run build` — COMPILED, EXIT=0 (all `/api/*` routes + `/tasks` + `/plans`
  in the route tree)

---

## 3. LIVE — PENDING

Each sub-phase ships a live probe (`_probe-6a-live.ts` … `_probe-6g-live.ts`)
that drives the real persistence service under the same anon-client + RLS
boundary the app relies on, printing only safe, probe-owned output. All probes
currently report PENDING for the same single upstream reason: there is no
`PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD` throwaway account in `.env.local`,
so no authenticated session (and therefore no `auth.uid()` ownership) exists
to run the lifecycles against. The Supabase project URL and publishable key
are present; the migrations for 6A/6F/6G still need to be applied
(`supabase migration up` / `db push`).

```
[probe] supabase url present=true publishable key present=true probe account present=false
[probe] RESULT PENDING — probe account or Supabase env missing
```

To reach LIVE=OK: add the two probe vars, apply the migrations, then re-run
each `_probe-<phase>-live.ts` in order.

---

## 4. BROWSER — PENDING (manual checklist)

No phase has been verified in a browser yet. Each sub-phase report lists its
own manual checklist (6G: `/tasks` + `/plans` boards and the deterministic
task chat commands; 6F: `/memory` badges, switch, veto; 6D: `/documents`
upload + grounding; 6C: image generation/editing; 6E: realtime advisories;
6B: routing across branches; 6A: personas + timezone).

---

## 5. PHASE 6 STATUS:

- **AUTOMATED**: DONE — 6A–6G fully green, 17 suites;
  tsc/lint/build clean.
- **LIVE**: PENDING — single upstream blocker: probe credentials absent
  (`PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD`) + migrations not yet applied.
- **BROWSER**: PENDING — manual checklists in each sub-phase report.