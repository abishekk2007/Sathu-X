import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 4B server-side student intelligence engine.
 *
 * Responsibilities:
 *  1. Fetch bounded academic context (profile fields, subjects, topics,
 *     knowledge state) through the session-authenticated Supabase client so
 *     RLS scopes every row to the caller.
 *  2. Build a compact academic-context block appended to the Gemini system
 *     instruction (Student mode personalization).
 *  3. Detect EXPLICIT weakness phrases ("I don't understand X") and nudge the
 *     matched topic's confidence down — only when a real topic matches.
 *  4. Apply deterministic practice-outcome scoring (no embeddings, no ML).
 *
 * Deliberately NOT here (later phases): RAG, vector search, predictive ML.
 */

// ---------------------------------------------------------------------------
// Tunable constants — the UI never hardcodes these.
// ---------------------------------------------------------------------------

/** mastery >= STRONG → mastered/strong. */
export const MASTERY_STRONG_THRESHOLD = 80;
/** mastery >= LEARNING and below STRONG → learning. */
export const MASTERY_LEARNING_THRESHOLD = 60;
/** mastery >= REVIEW and below LEARNING → needs review; below → weak. */
export const MASTERY_REVIEW_THRESHOLD = 40;

export const KNOWLEDGE_DEFAULT_STRENGTH = 50;
export const KNOWLEDGE_DEFAULT_CONFIDENCE = 50;

/** Practice deltas — deliberately gentle; repetition moves scores gradually. */
const DELTA_CORRECT = { strength: 5, confidence: 8, mastery: 6 };
const DELTA_INCORRECT = { strength: -6, confidence: -10, mastery: -4 };

/** Context bounds (Step 25) — prompt size stays controlled. */
const ACADEMIC_SUBJECT_CAP = 20;
const CONTEXT_BLOCK_SUBJECT_CAP = 8;
const WEAK_TOPIC_CAP = 10;
const STRONG_TOPIC_CAP = 10;
const TOPIC_SCAN_CAP = 400;
const STUDENT_BLOCK_CHAR_BUDGET = 1600;

// ---------------------------------------------------------------------------
// Shapes shared with routes
// ---------------------------------------------------------------------------

export interface AcademicFacts {
  course: string | null;
  year: string | null;
  college: string | null;
  department: string | null;
  semester: string | null;
  academicGoal: string | null;
  learningStyle: string | null;
  preferredLanguage: string | null;
  targetScore: string | null;
}

export interface StudentSubjectRef {
  id: string;
  name: string;
  code: string | null;
}

export interface StudentTopicRef {
  id: string;
  subjectId: string;
  name: string;
  mastery: number;
  status: string;
}

export interface KnowledgeState {
  id: string;
  topicId: string | null;
  strengthScore: number;
  confidenceScore: number;
  attemptCount: number;
  correctCount: number;
  lastReviewedAt: string | null;
}

export interface ChatAcademicContext {
  academic: AcademicFacts | null;
  subjects: StudentSubjectRef[];
  /** All recent topics (bounded) — used for weakness-phrase matching. */
  scanTopics: StudentTopicRef[];
  weakTopics: StudentTopicRef[];
  strongTopics: StudentTopicRef[];
  selectedSubject: StudentSubjectRef | null;
  selectedTopic: StudentTopicRef | null;
  selectedKnowledge: KnowledgeState | null;
}

export type MasteryBand =
  | "mastered"
  | "strong"
  | "learning"
  | "needs_review"
  | "weak";

/** Serializes a raw subject_topics row for API responses (snake → camel). */
export function serializeTopicRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    subjectId: row.subject_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    unit: (row.unit as string | null) ?? null,
    status: row.status as string,
    mastery: Number(row.mastery ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// Deterministic classification + scoring
// ---------------------------------------------------------------------------

/** Maps a 0–100 mastery value onto the Phase 4B strength/weakness bands. */
export function classifyMastery(
  mastery: number
): "strong" | "learning" | "needs_review" | "weak" {
  const value = Math.max(0, Math.min(100, Math.round(mastery)));
  if (value >= MASTERY_STRONG_THRESHOLD) return "strong";
  if (value >= MASTERY_LEARNING_THRESHOLD) return "learning";
  if (value >= MASTERY_REVIEW_THRESHOLD) return "needs_review";
  return "weak";
}

/**
 * Derives the topic status implied by a mastery value. Used after practice
 * outcomes; manual status edits via the API always win until the next
 * practice result re-derives it.
 */
export function deriveTopicStatus(
  mastery: number
): "mastered" | "learning" | "review" {
  if (mastery >= MASTERY_STRONG_THRESHOLD) return "mastered";
  if (mastery >= MASTERY_LEARNING_THRESHOLD) return "learning";
  return "review";
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export interface NextKnowledge {
  strengthScore: number;
  confidenceScore: number;
  attemptCount: number;
  correctCount: number;
  lastReviewedAt: string;
}

/**
 * Pure deterministic update for one practice outcome. Everything clamps to
 * 0–100; counters never go negative.
 */
export function computeNextKnowledge(
  current: Pick<
    KnowledgeState,
    | "strengthScore"
    | "confidenceScore"
    | "attemptCount"
    | "correctCount"
  > | null,
  correct: boolean
): NextKnowledge {
  const base = {
    strengthScore: current?.strengthScore ?? KNOWLEDGE_DEFAULT_STRENGTH,
    confidenceScore: current?.confidenceScore ?? KNOWLEDGE_DEFAULT_CONFIDENCE,
    attemptCount: current?.attemptCount ?? 0,
    correctCount: current?.correctCount ?? 0,
  };
  const delta = correct ? DELTA_CORRECT : DELTA_INCORRECT;
  return {
    strengthScore: clampScore(base.strengthScore + delta.strength),
    confidenceScore: clampScore(base.confidenceScore + delta.confidence),
    attemptCount: Math.max(0, base.attemptCount + 1),
    correctCount: Math.min(
      Math.max(0, base.correctCount + (correct ? 1 : 0)),
      Math.max(0, base.attemptCount + 1)
    ),
    lastReviewedAt: new Date().toISOString(),
  };
}

/**
 * The topic-level mastery implied by a practice outcome: nudged from the
 * previous mastery (when known) toward the knowledge-derived band.
 */
export function computeNextTopicMastery(
  currentMastery: number | null | undefined,
  knowledgeBefore: Pick<KnowledgeState, "attemptCount"> | null,
  correct: boolean
): number {
  // First-ever practice anchors at the neutral 50 midpoint instead of 0 so
  // one right answer doesn't jump a fresh topic to 56% "almost there".
  const anchor = knowledgeBefore ? null : 44;
  const start = anchor ?? currentMastery ?? 50;
  const delta = correct ? DELTA_CORRECT.mastery : DELTA_INCORRECT.mastery;
  return clampScore(start + delta);
}

// ---------------------------------------------------------------------------
// Fetching bounded context (RLS-scoped)
// ---------------------------------------------------------------------------

function normalizeRow(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

interface ProfileAcademicRow {
  course: string | null;
  year: string | null;
  college: string | null;
  department: string | null;
  semester: string | null;
  academic_goal: string | null;
  learning_style: string | null;
  preferred_language: string | null;
  target_score: string | null;
}

/** Raw student_knowledge row shape (snake_case columns). */
interface KnowledgeDbRow {
  id: string;
  topic_id: string | null;
  strength_score: number;
  confidence_score: number;
  attempt_count: number;
  correct_count: number;
  last_reviewed_at: string | null;
}

export async function fetchAcademicFacts(
  supabase: SupabaseClient
): Promise<AcademicFacts | null> {
  const { data } = await supabase
    .from("profiles")
    .select(
      "course, year, college, department, semester, academic_goal, " +
        "learning_style, preferred_language, target_score"
    )
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as ProfileAcademicRow;
  return {
    course: row.course,
    year: row.year,
    college: row.college,
    department: row.department,
    semester: row.semester,
    academicGoal: row.academic_goal,
    learningStyle: row.learning_style,
    preferredLanguage: row.preferred_language,
    targetScore: row.target_score,
  };
}

async function fetchSubjectsForContext(
  supabase: SupabaseClient
): Promise<StudentSubjectRef[]> {
  const { data } = await supabase
    .from("subjects")
    .select("id, name, code")
    .order("updated_at", { ascending: false })
    .limit(ACADEMIC_SUBJECT_CAP);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    code: (row.code as string | null) ?? null,
  }));
}

async function fetchTopicsScan(
  supabase: SupabaseClient
): Promise<StudentTopicRef[]> {
  const { data } = await supabase
    .from("subject_topics")
    .select("id, subject_id, name, mastery, status")
    .order("updated_at", { ascending: false })
    .limit(TOPIC_SCAN_CAP);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    subjectId: String(row.subject_id),
    name: String(row.name),
    mastery: Number(row.mastery ?? 0),
    status: String(row.status ?? "not_started"),
  }));
}

/**
 * Loads everything the chat route needs in parallel. The optional selection
 * comes from the client, but existence is verified through RLS-scoped reads —
 * foreign IDs simply resolve to null.
 */
export async function fetchChatAcademicContext(
  supabase: SupabaseClient,
  selection: { subjectId?: string; topicId?: string } | undefined
): Promise<ChatAcademicContext> {
  const [academic, subjects, scanTopics] = await Promise.all([
    fetchAcademicFacts(supabase),
    fetchSubjectsForContext(supabase),
    fetchTopicsScan(supabase),
  ]);

  let selectedSubject: StudentSubjectRef | null = null;
  let selectedTopic: StudentTopicRef | null = null;
  let selectedKnowledge: KnowledgeState | null = null;

  if (selection?.topicId) {
    const { data } = await supabase
      .from("subject_topics")
      .select("id, subject_id, name, mastery, status")
      .eq("id", selection.topicId)
      .maybeSingle();
    if (data) {
      const row = normalizeRow(data);
      selectedTopic = {
        id: String(row.id),
        subjectId: String(row.subject_id),
        name: String(row.name),
        mastery: Number(row.mastery ?? 0),
        status: String(row.status ?? "not_started"),
      };
    }
  }

  const subjectId = selection?.subjectId ?? selectedTopic?.subjectId;
  if (subjectId) {
    const match = subjects.find((subject) => subject.id === subjectId);
    if (match) {
      selectedSubject = match;
    } else {
      const { data } = await supabase
        .from("subjects")
        .select("id, name, code")
        .eq("id", subjectId)
        .maybeSingle();
      if (data) {
        const row = normalizeRow(data);
        selectedSubject = {
          id: String(row.id),
          name: String(row.name),
          code: (row.code as string | null) ?? null,
        };
      }
    }
  }

  if (selectedTopic) {
    const { data } = await supabase
      .from("student_knowledge")
      .select(
        "id, topic_id, strength_score, confidence_score, attempt_count, " +
          "correct_count, last_reviewed_at"
      )
      .eq("topic_id", selectedTopic.id)
      .maybeSingle();
    if (data) {
      const row = normalizeRow(data);
      selectedKnowledge = {
        id: String(row.id),
        topicId: (row.topic_id as string | null) ?? null,
        strengthScore: Number(row.strength_score ?? 50),
        confidenceScore: Number(row.confidence_score ?? 50),
        attemptCount: Number(row.attempt_count ?? 0),
        correctCount: Number(row.correct_count ?? 0),
        lastReviewedAt: (row.last_reviewed_at as string | null) ?? null,
      };
    }
  }

  const active = scanTopics.filter((topic) => topic.status !== "not_started");
  const weakTopics = [...active]
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, WEAK_TOPIC_CAP);
  const strongTopics = [...active]
    .sort((a, b) => b.mastery - a.mastery)
    .filter((topic) => topic.mastery >= MASTERY_LEARNING_THRESHOLD)
    .slice(0, STRONG_TOPIC_CAP);

  return {
    academic,
    subjects,
    scanTopics,
    weakTopics,
    strongTopics,
    selectedSubject,
    selectedTopic,
    selectedKnowledge,
  };
}

// ---------------------------------------------------------------------------
// Academic context block for Gemini
// ---------------------------------------------------------------------------

function subjectNameFor(
  context: ChatAcademicContext,
  subjectId: string
): string {
  return (
    context.subjects.find((subject) => subject.id === subjectId)?.name ??
    "Unknown subject"
  );
}

function pushBoundedList(
  lines: string[],
  heading: string,
  entries: string[]
): void {
  if (entries.length === 0) return;
  lines.push(`${heading}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`);
}

/**
 * Builds the STUDENT ACADEMIC CONTEXT block. Returns null when the student
 * has no academic data at all, so general users see zero extra noise.
 */
export function buildStudentContextBlock(
  context: ChatAcademicContext,
  extraNotes: string[] = []
): string | null {
  const sections: string[] = [];

  const academicLines: string[] = [];
  const academic = context.academic;
  if (academic) {
    if (academic.course) academicLines.push(`Course: ${academic.course}`);
    if (academic.department)
      academicLines.push(`Department: ${academic.department}`);
    if (academic.college) academicLines.push(`College: ${academic.college}`);
    if (academic.year) academicLines.push(`Year: ${academic.year}`);
    if (academic.semester) academicLines.push(`Semester: ${academic.semester}`);
    if (academic.academicGoal)
      academicLines.push(`Academic goal: ${academic.academicGoal}`);
    if (academic.learningStyle)
      academicLines.push(`Learning style: ${academic.learningStyle}`);
    if (academic.preferredLanguage)
      academicLines.push(`Preferred language: ${academic.preferredLanguage}`);
    if (academic.targetScore)
      academicLines.push(`Target score: ${academic.targetScore}`);
  }
  if (academicLines.length > 0) {
    sections.push(
      "STUDENT PROFILE:\n" +
        academicLines.map((line) => `- ${line}`).join("\n")
    );
  }

  if (context.subjects.length > 0) {
    pushBoundedList(
      sections,
      "SUBJECTS THE USER IS STUDYING",
      context.subjects
        .slice(0, CONTEXT_BLOCK_SUBJECT_CAP)
        .map((subject) =>
          subject.code ? `${subject.name} (${subject.code})` : subject.name
        )
    );
  }

  const describe = (topic: StudentTopicRef) =>
    `${topic.name} — ${classifyMastery(topic.mastery)}, mastery ${topic.mastery}/100 (${
      subjectNameFor(context, topic.subjectId)
    })`;

  pushBoundedList(
    sections,
    "WEAK TOPICS (needs patient, step-by-step support)",
    context.weakTopics.slice(0, WEAK_TOPIC_CAP).map(describe)
  );
  pushBoundedList(
    sections,
    "STRONG TOPICS (can handle advanced depth)",
    context.strongTopics.slice(0, STRONG_TOPIC_CAP).map(describe)
  );

  if (context.selectedSubject || context.selectedTopic) {
    const currentLines: string[] = [];
    if (context.selectedSubject) {
      currentLines.push(`Subject: ${context.selectedSubject.name}`);
    }
    if (context.selectedTopic) {
      currentLines.push(`Current topic: ${context.selectedTopic.name}`);
      currentLines.push(
        `Current topic mastery: ${context.selectedTopic.mastery}/100 (${classifyMastery(
          context.selectedTopic.mastery
        )})`
      );
      if (context.selectedKnowledge) {
        const k = context.selectedKnowledge;
        currentLines.push(
          `Practice record: ${k.correctCount}/${k.attemptCount} correct` +
            `, confidence ${k.confidenceScore}/100` +
            (k.lastReviewedAt
              ? `, last practiced ${new Date(k.lastReviewedAt).toLocaleDateString()}`
              : "")
        );
      }
    }
    sections.push(
      "CURRENTLY SELECTED ACADEMIC CONTEXT (the user explicitly chose this before chatting):\n" +
        currentLines.map((line) => `- ${line}`).join("\n")
    );
  }

  for (const note of extraNotes) {
    if (note.trim()) sections.push(note.trim());
  }

  if (sections.length === 0) return null;

  let block =
    "ACADEMIC CONTEXT about this user (use naturally to personalize explanations; " +
    "never mention database internals, scores tables, or that you were given this):\n" +
    sections.join("\n\n");

  if (block.length > STUDENT_BLOCK_CHAR_BUDGET) {
    block = block.slice(0, STUDENT_BLOCK_CHAR_BUDGET);
  }
  return block;
}

// ---------------------------------------------------------------------------
// Explicit weakness signals (Step 11) — regex only, no model call
// ---------------------------------------------------------------------------

const WEAKNESS_PATTERNS: RegExp[] = [
  /\bi\s+(?:don'?t|do\s+not|never)\s+(?:really\s+|fully\s+|quite\s+)?(?:understand|get|grasp)\s+(?:the\s+|this\s+|that\s+)?([a-z0-9][^.,!?\n]{2,80})/i,
  /\bi'?m\s+(?:really\s+|very\s+|so\s+)?(?:weak|bad|terrible|hopeless|stuck)\s+(?:at|in|with)\s+(?:the\s+|this\s+|that\s+)?([a-z0-9][^.,!?\n]{2,80})/i,
  /\bi\s+(?:always\s+)?struggle\s+(?:with|in)\s+(?:the\s+|this\s+|that\s+)?([a-z0-9][^.,!?\n]{2,80})/i,
  /\bi\s+keep\s+(?:getting|failing|messing\s+up)\s+(?:the\s+|this\s+|that\s+)?([a-z0-9][^.,!?\n]{2,80})/i,
];

const TRAILING_FILLER =
  /\b(can\s+you|could\s+you|please|help\s+me|explain|again|though|actually|anymore|anymore\.?)$/i;

function cleanPhrase(raw: string): string {
  let phrase = raw.trim().replace(/[.!?,;:]+$/, "");
  for (let i = 0; i < 3; i += 1) {
    const cleaned = phrase.replace(TRAILING_FILLER, "").trim();
    if (cleaned === phrase) break;
    phrase = cleaned.replace(/[.!?,;:]+$/, "");
  }
  return phrase;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3)
  );
}

function tokenSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export interface WeaknessSignal {
  topicId: string;
  topicName: string;
  phrase: string;
}

/**
 * Detects an explicit weakness phrase and confidently matches it to one of
 * the user's existing topics. Never invents topics — no confident match means
 * no signal. Confidence requires containment or solid token overlap.
 */
export function detectWeaknessSignal(
  message: string,
  topics: StudentTopicRef[]
): WeaknessSignal | null {
  if (topics.length === 0) return null;

  for (const pattern of WEAKNESS_PATTERNS) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const phrase = cleanPhrase(match[1]);
    if (phrase.length < 3) continue;

    const normalizedPhrase = phrase.toLowerCase();
    let best: { topic: StudentTopicRef; score: number } | null = null;

    for (const topic of topics) {
      const normalizedName = topic.name.toLowerCase();
      let score = 0;
      if (normalizedName === normalizedPhrase) score = 1;
      else if (normalizedName.includes(normalizedPhrase)) score = 0.95;
      else if (normalizedPhrase.includes(normalizedName)) score = 0.85;
      else {
        const similarity = tokenSimilarity(normalizedPhrase, normalizedName);
        if (similarity >= 0.6) score = similarity;
      }
      if (score > 0 && (!best || score > best.score)) best = { topic, score };
    }

    if (best && best.score >= 0.6) {
      return {
        topicId: best.topic.id,
        topicName: best.topic.name,
        phrase,
      };
    }
    // Only consider the first (most specific) matching pattern.
    return null;
  }
  return null;
}

/**
 * Applies a detected weakness signal: nudges the topic's practice confidence
 * down (creating a low-confidence record if none exists). Fail-open — chat is
 * never blocked by this bookkeeping.
 */
export async function applyWeaknessSignal(
  supabase: SupabaseClient,
  signal: WeaknessSignal
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("student_knowledge")
      .select("id, confidence_score")
      .eq("topic_id", signal.topicId)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("student_knowledge")
        .update({
          confidence_score: clampScore(
            Number(existing.confidence_score ?? KNOWLEDGE_DEFAULT_CONFIDENCE) -
              5
          ),
        })
        .eq("id", existing.id);
      return;
    }

    await supabase.from("student_knowledge").insert({
      topic_id: signal.topicId,
      strength_score: KNOWLEDGE_DEFAULT_STRENGTH - 5,
      confidence_score: 45,
    });
  } catch {
    console.error("[student-intelligence] Weakness signal update failed");
  }
}

// ---------------------------------------------------------------------------
// Practice outcome recording (Step 12) — used by /api/student/practice
// ---------------------------------------------------------------------------

export interface PracticeOutcomeResult {
  knowledge: KnowledgeState;
  topicMastery: number;
  topicStatus: "mastered" | "learning" | "review";
}

/**
 * Records one practice outcome for a topic the user owns (RLS enforces it):
 * updates the knowledge row deterministically, then mirrors the resulting
 * mastery/status back onto the topic so dashboards stay consistent.
 */
export async function recordPracticeOutcome(
  supabase: SupabaseClient,
  topicId: string,
  correct: boolean
): Promise<PracticeOutcomeResult | null> {
  const { data: topic } = await supabase
    .from("subject_topics")
    .select("id, mastery")
    .eq("id", topicId)
    .maybeSingle();
  if (!topic) return null;

  const { data: existing } = await supabase
    .from("student_knowledge")
    .select(
      "id, topic_id, strength_score, confidence_score, attempt_count, " +
        "correct_count, last_reviewed_at"
    )
    .eq("topic_id", topicId)
    .maybeSingle();

  const existingRow = existing
    ? (existing as unknown as KnowledgeDbRow)
    : null;

  const knowledgeBefore = existingRow
    ? {
        id: String(existingRow.id),
        topicId: (existingRow.topic_id as string | null) ?? null,
        strengthScore: Number(existingRow.strength_score ?? 50),
        confidenceScore: Number(existingRow.confidence_score ?? 50),
        attemptCount: Number(existingRow.attempt_count ?? 0),
        correctCount: Number(existingRow.correct_count ?? 0),
        lastReviewedAt: (existingRow.last_reviewed_at as string | null) ?? null,
      }
    : null;

  const next = computeNextKnowledge(knowledgeBefore, correct);

  let knowledgeRow: KnowledgeState;
  if (knowledgeBefore) {
    const { data, error } = await supabase
      .from("student_knowledge")
      .update({
        strength_score: next.strengthScore,
        confidence_score: next.confidenceScore,
        attempt_count: next.attemptCount,
        correct_count: next.correctCount,
        last_reviewed_at: next.lastReviewedAt,
      })
      .eq("id", knowledgeBefore.id)
      .select(
        "id, topic_id, strength_score, confidence_score, attempt_count, " +
          "correct_count, last_reviewed_at"
      )
      .single();
    if (error || !data) {
      console.error("[student-intelligence] Knowledge update failed");
      return null;
    }
    const updated = data as unknown as KnowledgeDbRow;
    knowledgeRow = {
      id: String(updated.id),
      topicId: (updated.topic_id as string | null) ?? null,
      strengthScore: Number(updated.strength_score),
      confidenceScore: Number(updated.confidence_score),
      attemptCount: Number(updated.attempt_count),
      correctCount: Number(updated.correct_count),
      lastReviewedAt: (updated.last_reviewed_at as string | null) ?? null,
    };
  } else {
    const { data, error } = await supabase
      .from("student_knowledge")
      .insert({
        topic_id: topicId,
        strength_score: next.strengthScore,
        confidence_score: next.confidenceScore,
        attempt_count: next.attemptCount,
        correct_count: next.correctCount,
        last_reviewed_at: next.lastReviewedAt,
      })
      .select(
        "id, topic_id, strength_score, confidence_score, attempt_count, " +
          "correct_count, last_reviewed_at"
      )
      .single();
    if (error || !data) {
      console.error("[student-intelligence] Knowledge insert failed");
      return null;
    }
    const inserted = data as unknown as KnowledgeDbRow;
    knowledgeRow = {
      id: String(inserted.id),
      topicId: (inserted.topic_id as string | null) ?? null,
      strengthScore: Number(inserted.strength_score),
      confidenceScore: Number(inserted.confidence_score),
      attemptCount: Number(inserted.attempt_count),
      correctCount: Number(inserted.correct_count),
      lastReviewedAt: (inserted.last_reviewed_at as string | null) ?? null,
    };
  }

  const topicMastery = computeNextTopicMastery(
    Number((topic as unknown as { mastery?: number }).mastery ?? 0),
    knowledgeBefore,
    correct
  );
  const topicStatus = deriveTopicStatus(topicMastery);

  const { error: topicError } = await supabase
    .from("subject_topics")
    .update({ mastery: topicMastery, status: topicStatus })
    .eq("id", topicId);
  if (topicError) {
    console.error("[student-intelligence] Topic mastery sync failed");
  }

  return {
    knowledge: knowledgeRow,
    topicMastery,
    topicStatus,
  };
}
