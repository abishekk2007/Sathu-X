// ---------------------------------------------------------------------------
// Study dashboard — real-data regression tests (sections A–J).
// Run with: npx tsx test-study-dashboard.ts
//
// Mocks only, no network / no Supabase / no Gemini / no DOM. Covers the pure
// aggregation + formatting logic that backs the Study dashboard:
//   A — new user (empty dataset) → honest empty states
//   B — existing user → real today/goal/subjects/flashcards/activity values
//   C — user isolation (pure functions only see their own rows + RLS)
//   D — no mock fallback on failure (route returns server_error; no mock)
//   E — empty dataset → empty-state fields (again, at the component boundary)
//   F — Study actions remain intact (tools, Practice deck, Continue → /chat)
//   G — daily goal resolution rules
//   H — recent-activity time labels, ordering and capping
//   I — flashcard due semantics (never reviewed / before today / after today)
//   J — flashcard serialization + subject-name join shape
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  activityTimeLabel,
  buildChatSources,
  buildDocumentSources,
  buildPlannerSources,
  buildRecentActivity,
  buildSubjects,
  computeFlashcardStats,
  computeTodayStudy,
  formatStudyMinutes,
  resolveDailyGoal,
} from "./src/lib/study-dashboard";
import { flashcardIsDue, serializeFlashcard } from "./src/lib/flashcards";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function assertEqual<T>(actual: T, expected: T, name: string) {
  assert(
    actual === expected,
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function assertDeepEqual<T>(actual: T, expected: T, name: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function assertContainsFile(file: string, needle: string, name: string) {
  const content = readFileSync(join(process.cwd(), file), "utf8");
  assert(
    content.includes(needle),
    name,
    `expected "${needle}" in ${file}`
  );
}

function assertNotInFile(file: string, needle: string, name: string) {
  const content = readFileSync(join(process.cwd(), file), "utf8");
  assert(
    !content.includes(needle),
    name,
    `"${needle}" must be ABSENT from ${file}`
  );
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TODAY = "2026-09-07";
const START = "2026-09-07T14:00:00Z";

// ---- A. New user: empty dataset → honest empty states ----------------------

{
  assertDeepEqual(
    computeTodayStudy([], []),
    { completed: 0, planned: 0 },
    "A1_new_user_today_study_zero"
  );
  assertEqual(
    resolveDailyGoal(null, []),
    null,
    "A2_new_user_no_daily_goal"
  );
  assertDeepEqual(
    buildSubjects([], []),
    [],
    "A3_new_user_no_subjects"
  );
  assertDeepEqual(
    computeFlashcardStats([], TODAY),
    { total: 0, due: 0 },
    "A4_new_user_no_flashcards"
  );
  assertDeepEqual(
    buildRecentActivity([], TODAY),
    [],
    "A5_new_user_no_activity"
  );
  assertEqual(
    formatStudyMinutes(0),
    "0m",
    "A6_new_user_zero_minutes_formatted"
  );
}

// ---- B. Existing user: real calculations ------------------------------------

{
  // Today's study: planner completed 60m + chat ended (1500s + 3000s = 75m).
  const planner = [
    { status: "completed", durationMinutes: 60 },
    { status: "planned", durationMinutes: 45 },
  ];
  const chat = [
    { started_at: START, ended_at: "2026-09-07T14:25:00Z", active_seconds: 1500 },
    { started_at: "2026-09-07T08:00:00Z", ended_at: null, active_seconds: 1800 },
    { started_at: "2026-09-07T10:00:00Z", ended_at: "2026-09-07T10:50:00Z", active_seconds: 3000 },
  ];
  const today = computeTodayStudy(planner, chat);
  assertEqual(today.completed, 135, "B1_today_completed_planner_plus_chat");
  assertEqual(today.planned, 105, "B2_today_planned_all_planner");
  assertEqual(formatStudyMinutes(today.completed), "2h 15m", "B3_format_135");
  assertEqual(formatStudyMinutes(75), "1h 15m", "B4_format_75");
  assertEqual(formatStudyMinutes(60), "1h", "B5_format_60");
  assertEqual(formatStudyMinutes(25), "25m", "B6_format_25");
  assertEqual(formatStudyMinutes(-8), "0m", "B7_negative_clamped");

  const subjects = [
    { id: "s1", name: "C Programming" },
    { id: "s2", name: "Engineering Physics" },
    { id: "s3", name: "Communication English" },
  ];
  const topics = [
    { id: "t1", subject_id: "s1", name: "Pointers & dynamic memory", mastery: 40, status: "learning" },
    { id: "t2", subject_id: "s1", name: "Arrays", mastery: 90, status: "mastered" },
    { id: "t3", subject_id: "s1", name: "Recursion", mastery: 20, status: "review" },
  ];
  const built = buildSubjects(subjects, topics);
  assertEqual(built.length, 3, "B8_subject_count");
  const cProgramming = built[0];
  assertEqual(cProgramming.name, "C Programming", "B9_subject_name");
  // progress = round((40+90+20)/3) = 50
  assertEqual(cProgramming.progress, 50, "B10_subject_progress_avg_mastery");
  // next = lowest-mastery non-mastered topic
  assertEqual(cProgramming.nextTopic, "Recursion", "B11_next_topic_lowest_mastery");
  assertEqual(built[1].progress, 0, "B12_subject_without_topics_zero");
  assertEqual(built[1].nextTopic, null, "B13_subject_without_topics_no_next");

  // All-mastered subject → explicit "All topics mastered".
  const mastered = buildSubjects(
    [{ id: "sM", name: "Matrices & Calculus" }],
    [
      { id: "m1", subject_id: "sM", name: "Eigenvalues", mastery: 88, status: "mastered" },
      { id: "m2", subject_id: "sM", name: "Matrices", mastery: 92, status: "mastered" },
    ]
  )[0];
  assertEqual(mastered.nextTopic, "All topics mastered", "B14_all_mastered_label");

  // Deterministic tie-break: same mastery → alphabetical name.
  const tie = buildSubjects(
    [{ id: "sT", name: "Tie Subject" }],
    [
      { id: "ta", subject_id: "sT", name: "Beta", mastery: 30, status: "learning" },
      { id: "tb", subject_id: "sT", name: "Alpha", mastery: 30, status: "learning" },
    ]
  )[0];
  assertEqual(tie.nextTopic, "Alpha", "B15_next_topic_tie_break");

  // Flashcards: never-reviewed + pre-midnight are due; post-midnight is not.
  const cards = [
    { last_reviewed_at: null },
    { last_reviewed_at: "2026-09-01T00:00:00Z" },
    { last_reviewed_at: "2026-09-08T00:00:00Z" },
    { last_reviewed_at: "2026-09-11T00:00:00Z" },
  ];
  assertDeepEqual(computeFlashcardStats(cards, TODAY), { total: 4, due: 2 }, "B16_flashcard_stats");
}

// ---- C. User isolation: pure functions only see their own rows ---------------

{
  const userA = buildSubjects(
    [{ id: "a", name: "C Programming" }],
    [{ id: "a1", subject_id: "a", name: "Recursion", mastery: 10, status: "learning" }]
  );
  const userB = buildSubjects(
    [{ id: "b", name: "Advanced Quantum Field Theory" }],
    [{ id: "b1", subject_id: "b", name: "Lagrangians", mastery: 55, status: "learning" }]
  );
  assertEqual(
    userA.some((s) => s.name === "Advanced Quantum Field Theory"),
    false,
    "C1_userA_never_sees_userB_subject"
  );
  assertEqual(userA[0].progress, 10, "C2_userA_progress_from_own_rows_only");
  assertEqual(userB[0].progress, 55, "C3_userB_progress_from_own_rows_only");

  // RLS: the flashcards migration scopes every policy to auth.uid().
  const migration = join(
    process.cwd(),
    "supabase/migrations/20260907000000_phase10_study_flashcards.sql"
  );
  const content = readFileSync(migration, "utf8");
  assert(
    (content.match(/auth\.uid\(\) = user_id/g) ?? []).length >= 4,
    "C4_flashcards_all_four_policies_owner_scoped"
  );
  assertContainsFile(
    "supabase/migrations/20260907000000_phase10_study_flashcards.sql",
    "enable row level security",
    "C5_flashcards_rls_enabled"
  );
  // Study-dashboard aggregation takes rows as inputs — it never filters by or
  // fabricates a user id; RLS is the only cross-user boundary.
  assertNotInFile(
    "src/lib/study-dashboard.ts",
    "auth.uid()",
    "C6_aggregation_is_pure_over_its_inputs"
  );
}

// ---- D. No mock fallback: a failed read yields server_error, never mocks ----

{
  assertNotInFile(
    "src/app/api/student/study-dashboard/route.ts",
    "from \"@/data/mock\"",
    "D1_dashboard_route_imports_no_mock_module",
  );
  assertNotInFile(
    "src/app/api/student/study-dashboard/route.ts",
    "mockStudy",
    "D1b_dashboard_route_uses_no_mock_study_data"
  );
  assertContainsFile(
    "src/app/api/student/study-dashboard/route.ts",
    'return jsonError(500, "server_error")',
    "D2_dashboard_route_errors_honestly"
  );
  assertNotInFile(
    "src/lib/study-dashboard.ts",
    "from \"@/data/mock\"",
    "D3_dashboard_lib_imports_no_mock_module"
  );
  assertNotInFile(
    "src/lib/study-dashboard.ts",
    "mockStudySubjects",
    "D3b_dashboard_lib_no_mock_subjects"
  );
  assertNotInFile(
    "src/lib/flashcards.ts",
    "mock",
    "D4_flashcards_lib_contains_no_mock_reference"
  );
  // The old hard-coded demo values must not survive anywhere in the Study UI.
  for (const needle of [
    "2h 15m",
    "Goal · 3h",
    "Review 4 cards",
    "Pointers & dynamic memory",
  ]) {
    assertNotInFile("src/components/study/study-dashboard.tsx", needle, `D5_no_${needle.replace(/[^a-zA-Z]/g, "")}`);
  }
  assertNotInFile("src/components/study/flashcard-deck.tsx", "mockFlashcards", "D6_deck_uses_no_mock_cards");
}

// ---- E. Empty dataset → empty-state fields ----------------------------------

{
  // The dashboard renders empty states derived from the payload's empty
  // collections (A covers the builders; here we pin the UI strings).
  assertContainsFile(
    "src/components/study/study-dashboard.tsx",
    "No subjects yet",
    "E1_subjects_empty_state_present"
  );
  assertContainsFile(
    "src/components/study/study-dashboard.tsx",
    "No study activity yet",
    "E2_activity_empty_state_present"
  );
  assertContainsFile(
    "src/components/study/study-dashboard.tsx",
    "Set a daily goal to start tracking",
    "E3_goal_empty_state_present"
  );
  assertContainsFile(
    "src/components/study/flashcard-deck.tsx",
    "No flashcards yet",
    "E4_flashcards_empty_state_present"
  );
}

// ---- F. Study actions remain intact (no redesign / no breakage) -------------

{
  assertContainsFile(
    "src/components/study/study-dashboard.tsx",
    "ToolDialog",
    "F1_tool_dialog_still_rendered"
  );
  assertContainsFile(
    "src/components/study/study-dashboard.tsx",
    'router.push("/chat")',
    "F2_continue_opens_real_chat"
  );
  assertContainsFile(
    "src/components/study/flashcard-deck.tsx",
    "Practice deck",
    "F3_practice_deck_action_present"
  );
  assertContainsFile(
    "src/app/(app)/study/page.tsx",
    "StudyDashboard",
    "F4_study_route_renders_dashboard"
  );
}

// ---- G. Daily goal resolution ----------------------------------------------

{
  assertEqual(resolveDailyGoal(null, []), null, "G1_no_goal_nowhere");
  assertEqual(resolveDailyGoal(180, []), 180, "G2_profile_goal_wins");
  assertEqual(
    resolveDailyGoal(null, [{ target_minutes: 150 }]),
    150,
    "G3_active_goal_fallback"
  );
  assertEqual(
    resolveDailyGoal(0, [{ target_minutes: null }, { target_minutes: 120 }]),
    120,
    "G4_zero_profile_goal_falls_back_to_goal"
  );
  assertEqual(
    resolveDailyGoal(null, [{ target_minutes: null }]),
    null,
    "G5_null_goal_stays_null"
  );
}

// ---- H. Recent activity: labels, ordering, capping ---------------------------

{
  const chatSources = buildChatSources([
    {
      started_at: "2026-09-07T14:00:00Z",
      ended_at: "2026-09-07T14:25:00Z",
      active_seconds: 1500,
      subject_id: "s1",
      topic_id: "t3",
      subjectName: "C Programming",
      topicName: "Recursion",
    },
    {
      started_at: "2026-09-07T11:00:00Z",
      ended_at: "2026-09-07T11:15:00Z",
      active_seconds: 900,
      subject_id: "s1",
      topic_id: "t3",
      subjectName: "C Programming",
      topicName: "Recursion",
    },
    {
      started_at: "2026-09-06T09:00:00Z",
      ended_at: "2026-09-06T09:10:00Z",
      active_seconds: 600,
      subject_id: "s2",
      topic_id: null,
      subjectName: "Engineering Physics",
      topicName: null,
    },
  ]);
  // Two sessions on s1/t3 group into one 40-minute entry.
  assertEqual(chatSources.length, 2, "H1_chat_grouped_by_subject_topic");
  assertEqual(chatSources[0].action, "Studied Recursion", "H2_chat_action_uses_topic");
  assertEqual(chatSources[0].subject, "C Programming", "H3_chat_subject_name");

  const plannerSources = buildPlannerSources([
    {
      status: "completed",
      completedAt: "2026-09-07T09:00:00Z",
      createdAt: "2026-09-06T09:00:00Z",
      subjectName: "C Programming",
      topicName: "Arrays",
      sessionType: "study",
    },
  ]);
  assertEqual(plannerSources[0].action, "Completed Study session", "H4_planner_action_label");
  assertEqual(plannerSources[0].subject, "Arrays", "H5_planner_subject_uses_topic");

  const docSources = buildDocumentSources([
    { name: "Unit 2 notes.pdf", created_at: "2026-09-05T10:00:00Z" },
  ]);
  assertEqual(docSources[0].action, "Uploaded Unit 2 notes.pdf", "H6_document_action");

  const all = buildRecentActivity(
    [...chatSources, ...plannerSources, ...docSources],
    TODAY
  );
  // Newest-first: chat (14:00) → planner (09:00) → chat yesterday (09-06) → doc (09-05).
  assertEqual(all.length, 4, "H7_activity_all_sources_merged");
  assertEqual(all[0].action, "Studied Recursion", "H8_activity_newest_first");
  assertEqual(all[0].timeLabel, "Today", "H9_activity_today_label");
  assertEqual(all[1].timeLabel, "Today", "H10_activity_second_today");
  assertEqual(all[2].timeLabel, "Yesterday", "H11_activity_yesterday_label");
  assertEqual(all[3].timeLabel, "2 days ago", "H12_activity_days_label");

  const capped = buildRecentActivity(
    [...chatSources, ...plannerSources, ...docSources],
    TODAY,
    2
  );
  assertEqual(capped.length, 2, "H13_activity_capped");
  assertEqual(activityTimeLabel("2026-09-07T12:00:00Z", TODAY), "Today", "H14_label_today_direct");
  assertEqual(activityTimeLabel("2026-09-06T12:00:00Z", TODAY), "Yesterday", "H15_label_yesterday_direct");
  assertEqual(activityTimeLabel("2026-09-03T12:00:00Z", TODAY), "4 days ago", "H16_label_multi_day_direct");
}

// ---- I. Flashcard due semantics ---------------------------------------------

{
  assertEqual(flashcardIsDue(null, TODAY), true, "I1_never_reviewed_is_due");
  assertEqual(
    flashcardIsDue("2026-09-01T00:00:00Z", TODAY),
    true,
    "I2_past_review_is_due"
  );
  assertEqual(
    flashcardIsDue("2026-09-08T00:00:00Z", TODAY),
    false,
    "I3_future_review_not_due"
  );
  assertEqual(
    flashcardIsDue("2026-09-11T00:00:00Z", TODAY),
    false,
    "I4_later_review_not_due"
  );
}

// ---- J. Flashcard serialization + subject join -------------------------------

{
  const row = {
    id: "fc1",
    subject_id: "s1",
    question: "What does a pointer store?",
    answer: "A memory address.",
    review_count: 3,
    last_reviewed_at: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
    subject: [{ name: "C Programming" }],
  };
  const card = serializeFlashcard(row, TODAY);
  assertEqual(card.subjectName, "C Programming", "J1_join_subject_name");
  assertEqual(card.reviewCount, 3, "J2_review_count_int");
  assertEqual(card.isDue, true, "J3_is_due_from_join_row");
  assertEqual(card.question, "What does a pointer store?", "J4_question_preserved");
  assertEqual(card.answer, "A memory address.", "J5_answer_preserved");

  const noSubject = serializeFlashcard(
    { ...row, subject_id: null, subject: null },
    TODAY
  );
  assertEqual(noSubject.subjectName, null, "J6_null_subject_join");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nstudy-dashboard tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((failure) => `  - ${failure}`).join("\n"));
  process.exit(1);
}