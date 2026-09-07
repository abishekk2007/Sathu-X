# Phase 10 — Study Dashboard Real-Data: Final Report

The SathuX Study dashboard (`/study`) now renders **real, current-user-scoped
data** served by `/api/student/study-dashboard` — no fabricated subjects,
activities, goal hours or flashcard counts anywhere in the flow.

---

## 1. Files changed / created

**New**
- `supabase/migrations/20260907000000_phase10_study_flashcards.sql` — new
  `public.flashcards` table + RLS + trigger + indexes.
- `src/lib/study-dashboard.ts` — pure, deterministic aggregation builders.
- `src/lib/flashcards.ts` — flashcard serializer, zod create/patch schemas,
  `flashcardIsDue`.
- `src/hooks/use-flashcards.ts` — client deck data hook.
- `src/app/api/flashcards/route.ts` — GET list (due-first, counts) / POST create.
- `src/app/api/flashcards/[id]/route.ts` — PATCH (whitelist) / DELETE.
- `src/app/api/flashcards/[id]/review/route.ts` — POST mark reviewed.
- `test-study-dashboard.ts` — 78 assertions, sections A–J.

**Rewritten**
- `src/app/api/student/study-dashboard/route.ts` — 13 bounded parallel
  RLS-scoped reads; payload extended with real goal, subjects, flashcard counts,
  recent activity.
- `src/components/study/study-dashboard.tsx` — real Today goal, real subjects +
  next topic, real recent activity, loading/error/empty states, `Continue` →
  `/chat` (no fake toast).
- `src/components/study/flashcard-deck.tsx` — live deck (flip / prev / next),
  Mark reviewed, delete, AddCardForm with real subject selector.

**Edited**
- `src/types/index.ts` — `StudySubject.nextTopic` → `string | null`,
  `StudyActivity` new fields, added `StudyFlashcard`, extended
  `StudyDashboardData` with `todayCompletedMinutes`, `todayPlannedMinutes`,
  `dailyGoalMinutes`, `subjects`, `flashcards`, `recentActivity`.

## 2. Data sources

| Widget | Source | RLS scope |
|---|---|---|
| Today study minutes | `study_sessions` (completed, planner) + `chat_study_sessions` (ended, `active_seconds`) | `auth.uid()` |
| Daily goal | `profiles.daily_study_target_minutes` → newest `study_goals.target_minutes` | own |
| Subjects grid | `subjects` + all `subject_topics` | parent subject owned |
| Flashcards | new `flashcards` | own |
| Recent activity | chat sessions + planner sessions + documents | own |
| Streak / week plan | existing planner reads (preserved) | own |

## 3. Every calculation

- **Today minutes**: `completed = Σ planner duration` (status `completed`) +
  `Σ round(active_seconds / 60)` for chat sessions whose `started_at` date
  equals today (ascending-order stop: `active_seconds` is the authoritative
  elapsed field). `planned = Σ all planner duration`.
- **Goal resolution**: profile target if `> 0`, else newest active
  `study_goals` entry with non-null `target_minutes`, else unset (`null` UI).
- **Subject progress**: `round(mean(mastery))` of its topics; `0` when no
  topics.
- **Next topic**: lowest-mastery non-`mastered` topic (tie-break: name);
  subjects with zero topics → no next topic; all mastered →
  `"All topics mastered"`.
- **Flashcard counts**: `total` = user's cards; `due` = cards with
  `last_reviewed_at` null or before local midnight of "today" (numeric date
  compare, no timezone/date-package drift).
- **Recent activity**: chat sessions grouped by subject+topic (summed seconds,
  most recent `started_at` → `"Studied <topic>"`; no topic → `"Studied
  <subject>"`), planner completions (`"Completed Study session"`), document
  uploads (`"Uploaded <name>"`); merged, sorted newest-first by ISO timestamp,
  capped at 5.

## 4. Determinism & no fake fallback

- All aggregation lives in `src/lib/study-dashboard.ts` /
  `src/lib/flashcards.ts` — pure functions of the caller's RLS-scoped rows; no
  `Math.random`, no timezone-package math.
- A failed database read returns `jsonError(500, "server_error")`. No mock or
  hard-coded data is ever injected in a catch path.
- No demo values (`"2h 15m"`, `"Goal · 3h"`, `"Review 4 cards"`) remain in the
  Study UI or its API.

## 5. Why a flashcards system was built (and where it came from)

No flashcard table, API or deck existed anywhere (memory types cover only
preference/profile/project/workflow/instruction/fact/goal). The prompt
requires a working "Practice deck" backed by a real count and real data, and a
no-fake-button guarantee, so a first, minimal system is added via migration +
3 routes. It is the first such system, not a duplicate.

## 6. Flashcard API semantics

- List: `?today=` + `?limit=` (default 30); due cards first, then newest.
- Create: zod `createCardSchema` (question 1–500, answer 1–5000, subject
  nullable); subject reference re-verified against the owner's `subjects`.
- Update: PATCH whitelist, same validation.
- Review: `review_count + 1`, `last_reviewed_at = now()`.
- Delete: 404 for non-owned / missing ids per Flask-style route errors.

## 7. Security & RLS

- `flashcards`: all four policies owner-scoped (`auth.uid() = user_id` —
  `with check` on write policies), `select/insert/update/delete` derive
  identity solely from the session; insert on a `subject_id` requires that
  subject's owner to equal the session user.
- `subject_id` on delete → `set null`; `flashcards_set_updated_at` trigger
  maintained on update.
- Server routes are `runtime = "nodejs"`, `context.params` handled as a
  Promise (Next 16), `verifySubjectReference` reused from
  `src/lib/exam-helpers.ts`.
- Flashcard OCR ("reading") uses `parseDateOnly`-based numeric comparison, not
  date mutability.

## 8. Reuse (nothing reinvented)

- Existing `study_sessions`, `chat_study_sessions`, `study_goals`, `subjects`,
  `subject_topics`, `plans`, `documents` tables power every widget.
- `getAuthenticatedUser` / `getSupabaseServerClient` (server), `requestJson`
  + `AsyncState<T>` hook pattern, `toast`, `Card`, `Progress`, `Button`,
  `Dialog*`, `EmptyState` conventions all reused.
- The existing `/api/subjects` endpoint feeds the deck's subject selector.

## 9. Backward compatibility

- Study-dashboard payload **only adds keys**; nothing removed or renamed.
- `student-view.tsx`'s dashboard mapping continues to work (its `subjects`
  list is now real study subjects via the same endpoint).
- `/study` route, study tools, and the chat/planner/document flows are
  untouched.

## 10. Tests (A–J) — all passing

`npx tsx test-study-dashboard.ts` → **78 passed, 0 failed**; regression
`npx tsx test-smart-learning.ts` → **112 passed**.

- A new user (empty dataset) → all-zero/honest empty states.
- B existing user → real today/goal/subjects/flashcards/activity values incl.
  progress averaging and next-topic selection.
- C user isolation → pure functions only see their rows; migration policies
  all `auth.uid()`, RLS enabled.
- D no mock fallback → routes/libs carry no mock imports; error path is
  `server_error`; old demo strings absent.
- E empty-state UI strings present at the component boundary.
- F actions intact → ToolDialog rendered, `Continue` opens `/chat`, Practice
  deck + add/review flows present, `/study` page renders the dashboard.
- G daily-goal resolution rules (profile > active goal > unset; 0/null
  handling).
- H activity labels, ordering, grouping, capping.
- I flashcard due semantics (never-reviewed / past / future).
- J flashcard serialization + subject-name join shape.

## 11. Typechecks, lint, build

- `npx tsc --noEmit` → clean.
- `npx eslint <all changed files>` → clean.
- `npx next build` → success; route list includes `/api/flashcards`,
  `/api/flashcards/[id]`, `/api/flashcards/[id]/review`; `/study` renders.

## 12. Database migration

`20260907000000_phase10_study_flashcards.sql` adds only `public.flashcards`,
three indexes, four RLS policies (`flashcards_select_own` / `_insert_own` /
`_update_own` / `_delete_own`) and the `set_updated_at` trigger. No existing
table or policy is altered. Apply via the standard Supabase migration flow;
cards created for subjects use `on delete set null`.

## 13. Remaining demo usage (classified, deliberately out of scope)

- **Study tool cards** (`mockStudyTools` / `mockToolResults` in
  `src/data/mock.ts`): the Tool dialog runner is a working demo explicitly
  designed to be swapped for real services later (its UI says so); §10
  forbids redesigning/breaking it — kept, documented as a limitation.
- **Landing `student-section.tsx`**: intentional marketing demo
  ("Auto-generated quizzes and flashcards" on the marketing page); not a user
  dashboard, left unchanged (classified in §18).
- **`src/data/mock.ts` fixture exports**: `mockStudySubjects`,
  `mockStudyActivities`, `mockFlashcards` are now **unused** (no importers) —
  harmless demo fixtures left for the demo surface.

---
No commit / push / deploy was performed; local validation only.