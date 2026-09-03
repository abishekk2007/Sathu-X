export type AiMode = "general" | "student" | "assistant";

export type ConversationGroup =
  | "today"
  | "yesterday"
  | "previous-7-days"
  | "older";

export interface Conversation {
  id: string;
  title: string;
  mode: AiMode;
  group: ConversationGroup;
  messages: ChatMessage[];
  /** ISO timestamp from the database; drives sidebar ordering. */
  updatedAt?: string;
}

export type MessageRole = "user" | "assistant";

/**
 * UI-only states for the demo chat experience.
 * When the real backend lands, streaming/thinking/error will be driven by it.
 */
export type MessageStatus = "thinking" | "streaming" | "complete" | "error";

// Phase 6C — generated-image payload attached to an assistant message.
// The data URL is validated server-side before it is ever rendered.
export interface ChatImageAttachment {
  provider: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  fileSizeBytes?: number;
  prompt?: string;
  /** Phase 6D — present when this image is an edit/regeneration result. */
  mode?: "edit" | "regenerate";
  /** Phase 6D — key of the source image this edit was derived from. */
  editSourceKey?: string;
  /** Phase 6E — true when the image was grounded in retrieved document evidence. */
  sourceGrounded?: boolean;
  /** Phase 6E — closed-taxonomy visual type (e.g. "chart", "flowchart"). */
  visualType?: string | null;
}

/**
 * Phase 6D — conversation image metadata sent with a chat request (metadata
 * only; the single selected source's bytes travel separately in `editImage`).
 */
export interface ChatImageContextItem {
  key: string;
  provider?: string;
  mimeType?: string;
  prompt?: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Phase 7C — web research citations
// ---------------------------------------------------------------------------

/**
 * Phase 7C — a single citation the app surfaced for a web-researched answer.
 */
export interface ChatSource {
  /** 1-based citation number shown in the UI. */
  index: number;
  title: string;
  url: string;
  domain: string;
  /** Best-effort publication date (YYYY-MM-DD) when the provider reported one. */
  publishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Phase 7F — web image results + shared location
// ---------------------------------------------------------------------------

/**
 * A web image surfaced by an image search ("show me images of…"). App-owned
 * https URLs from the server control frame — never model-invented. Rendered in
 * a dedicated grid that stays visually distinct from generated/camera images.
 */
export interface ChatWebImage {
  url: string;
  title?: string;
  description?: string;
}

/**
 * A coarse location the user shared deliberately via the composer pin. Only
 * the rounded (~1.1 km) coords ever leave the browser; the raw GPS reading is
 * discarded inside `sanitizeUserLocation`.
 */
export interface ChatSharedLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * A normalised place result for rendering on a Leaflet map. Coordinates are
 * always validated — entries without valid coordinates are filtered out before
 * reaching the UI. `openInGoogleMaps` is an app-built link, never model-invented.
 */
export interface MapPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category?: string;
  address?: string;
  distanceMeters?: number;
  sourceUrl?: string;
  openInGoogleMaps?: string;
}

/**
 * Phase 7D — a single document citation surfaced for a document-grounded
 * (or hybrid) answer. App-owned metadata derived from the real retrieval
 * results — never model-invented. No URL: these point at the user's uploaded
 * documents, identified by source name (+ best-effort page number).
 */
export interface ChatDocumentCitation {
  /** Document / source id the passage came from. */
  sourceId: string;
  /** Human-readable document / source name. */
  sourceName: string;
  /** Best-effort page number when the retrieved passage carried one. */
  page: number | null;
}

// Phase 7E — camera-captured image attached to a USER message. The data URL
// is a normalized, bounded JPEG produced client-side and validated server-side
// before the assistant ever depends on it.
export interface ChatUserImageAttachment {
  dataUrl: string;
  mimeType: string;
  name: string;
  width?: number;
  height?: number;
  fileSizeBytes?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timeLabel: string;
  status?: MessageStatus;
  /** Present only on assistant messages that carry a generated image. */
  image?: ChatImageAttachment;
  /** Phase 7E — camera-captured image attached to a user message. */
  userImage?: ChatUserImageAttachment;
  /** Phase 7C — real web-research citations (from application data, never
   *  model-invented). Present only on web-researched assistant messages. */
  sources?: ChatSource[];
  /** Phase 7D — real document citations for a document-grounded or hybrid
   *  answer (from application data, never model-invented). */
  documentCitations?: ChatDocumentCitation[];
  /** Phase 7C — true when research partially failed or returned no usable
   *  sources; the answer then does not claim to be web-verified. */
  researchDegraded?: boolean;
  /** Phase 7F — real web image results (from application data, never
   *  model-invented). Present only on image-search assistant messages. */
  webImages?: ChatWebImage[];
  /** Phase 7F — coarse location the user shared with this user message. */
  userLocation?: ChatSharedLocation;
  /** Phase 8 — real nearby places fetched from Nominatim for this assistant
   *  message's location context. Never model-invented. */
  places?: MapPlace[];
}

export type LegacyDocumentStatus = "ready" | "processing" | "failed";
export type DocumentType = "pdf" | "docx" | "txt" | "png" | "jpg" | "pptx" | "md" | "webp";

export interface SpideyDocument {
  id: string;
  name: string;
  type: DocumentType;
  sizeLabel: string;
  dateLabel: string;
  status: LegacyDocumentStatus;
}

// ---------------------------------------------------------------------------
// Phase 5A — document upload & management
// ---------------------------------------------------------------------------

export const DOCUMENT_STATUSES = [
  "uploaded",
  "processing",
  "ready",
  "failed",
  "deleted",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_PROCESSING_STATUSES = [
  "pending",
  "extracting",
  "chunking",
  "embedding",
  "ready",
  "failed",
] as const;

export type DocumentProcessingStatus =
  (typeof DOCUMENT_PROCESSING_STATUSES)[number];

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.presentationml.document",
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export interface DocumentRecord {
  id: string;
  userId: string;
  subjectId: string | null;
  topicId: string | null;
  name: string;
  originalFilename: string;
  storagePath: string;
  mimeType: string;
  fileSizeBytes: number;
  status: DocumentStatus;
  processingStatus: DocumentProcessingStatus;
  errorMessage: string | null;
  /** Character count of extracted text (populated after processing). */
  extractedTextLength: number | null;
  /** Timestamp when extraction completed successfully. */
  processedAt: string | null;
  /** Human-readable error when processing fails. */
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Resolved subject name — included in list responses when available. */
  subjectName?: string | null;
  /** Resolved topic name — included in list responses when available. */
  topicName?: string | null;
}

export interface DocumentFilters {
  search?: string;
  subjectId?: string;
  topicId?: string;
  status?: DocumentStatus;
  page?: number;
  limit?: number;
}

export interface DocumentUploadResult {
  document: DocumentRecord;
}

export type TaskPriority = "high" | "medium" | "low";
export type TaskBucket = "today" | "upcoming" | "completed";

export interface Task {
  id: string;
  title: string;
  dueLabel: string;
  priority: TaskPriority;
  category: string;
  completed: boolean;
}

// ---- Phase 6G: real (API-backed) task + plan shapes -----------------------
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled" | "failed";
export type TaskRecurrence = "none" | "daily" | "weekly" | "monthly";
export type PlanStatus = "active" | "completed" | "cancelled";
export type StepStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface ClientTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  recurrence: TaskRecurrence;
  tags: string[];
  source: "chat" | "ui" | "plan";
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientPlanStep {
  id: string;
  planId: string;
  title: string;
  description: string | null;
  position: number;
  status: StepStatus;
  dependsOn: string[];
  taskId: string | null;
  estimatedMinutes: number | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientPlan {
  id: string;
  title: string;
  objective: string;
  description: string | null;
  status: PlanStatus;
  dueAt: string | null;
  source: "chat" | "ui";
  createdAt: string;
  updatedAt: string;
}

export interface Reminder {
  id: string;
  title: string;
  dayLabel: string;
  timeLabel: string;
  completed: boolean;
}

export const MEMORY_CATEGORIES = [
  "general",
  "preference",
  "education",
  "personal",
  "project",
  "academic",
  "work",
  "goal",
  "communication",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Phase 6F typed taxonomy (also served by /api/memories as `type`). */
export const MEMORY_TYPES = [
  "preference",
  "profile",
  "project",
  "workflow",
  "instruction",
  "fact",
  "goal",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Row shape returned by /api/memories. */
export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  /** 1 (nice to know) … 5 (core fact about the user). */
  importance: number;
  createdAt: string;
  updatedAt: string;
  // Phase 6F typed model.
  type: MemoryType;
  key: string | null;
  source: "explicit" | "inferred";
  confidence: "high" | "medium" | "low";
  enabled: boolean;
  lastUsedAt: string;
}

/** Editable profile fields served by /api/profile. */
export interface ProfileRecord {
  fullName: string | null;
  avatarUrl: string | null;
  email: string | null;
  bio: string | null;
  college: string | null;
  course: string | null;
  year: string | null;
  preferredMode: AiMode;
  department: string | null;
  semester: string | null;
  academicGoal: string | null;
  learningStyle: string | null;
  preferredLanguage: string | null;
  targetScore: string | null;
}

// ---------------------------------------------------------------------------
// Phase 4B — student intelligence
// ---------------------------------------------------------------------------

export const TOPIC_STATUSES = [
  "not_started",
  "learning",
  "review",
  "mastered",
] as const;

export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/** Row shape returned by the subject APIs. */
export interface SubjectRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  semester: string | null;
  credits: number | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape returned by the topic APIs. */
export interface TopicRecord {
  id: string;
  subjectId: string;
  name: string;
  description: string | null;
  unit: string | null;
  status: TopicStatus;
  /** 0–100. */
  mastery: number;
  /** Last practice time, merged from student_knowledge when present. */
  lastReviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Knowledge-state row (practice-derived) returned by the knowledge APIs. */
export interface KnowledgeRecord {
  id: string;
  topicId: string | null;
  strengthScore: number;
  confidenceScore: number;
  attemptCount: number;
  correctCount: number;
  lastReviewedAt: string | null;
  updatedAt: string;
}

/** Aggregated payload served by GET /api/student/dashboard. */
export interface StudentDashboardData {
  stats: {
    subjects: number;
    topics: number;
    overallMastery: number | null;
    strongTopics: number;
    needsReviewTopics: number;
    weakTopics: number;
    practicedTopics: number;
  };
  subjects: Array<{
    id: string;
    name: string;
    code: string | null;
    semester: string | null;
    color: string | null;
    topicCount: number;
    avgMastery: number | null;
  }>;
  weakAreas: StudentTopicHighlight[];
  strongAreas: StudentTopicHighlight[];
  recentActivity: StudentRecentActivity[];
  insights: string[];
}

export interface StudentTopicHighlight {
  topicId: string;
  topicName: string;
  subjectName: string;
  mastery: number;
}

export interface StudentRecentActivity {
  topicName: string;
  subjectName: string | null;
  reviewedAt: string;
}

// ---------------------------------------------------------------------------
// Phase 4C — study planner + exam system
// ---------------------------------------------------------------------------

export const EXAM_TYPES = [
  "semester",
  "internal",
  "unit_test",
  "practical",
  "assignment",
  "other",
] as const;

export type ExamType = (typeof EXAM_TYPES)[number];

export const EXAM_STATUSES = [
  "upcoming",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const STUDY_PLAN_STATUSES = [
  "draft",
  "active",
  "completed",
  "paused",
  "archived",
] as const;

export type StudyPlanStatus = (typeof STUDY_PLAN_STATUSES)[number];

export const SESSION_TYPES = [
  "study",
  "revision",
  "practice",
  "mock_test",
  "review",
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "skipped",
  "cancelled",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const GOAL_STATUSES = [
  "active",
  "completed",
  "paused",
  "cancelled",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Row shape returned by the exam APIs. */
export interface ExamRecord {
  id: string;
  subjectId: string | null;
  title: string;
  /** ISO timestamptz string. */
  examDate: string;
  examType: ExamType;
  description: string | null;
  /** 0–100 or null. */
  targetScore: number | null;
  /** 1 (low) … 5 (critical). */
  priority: number;
  status: ExamStatus;
  createdAt: string;
  updatedAt: string;
  subjectName?: string | null;
}

/** Row shape returned by the study-plan APIs. */
export interface StudyPlanRecord {
  id: string;
  name: string;
  description: string | null;
  /** YYYY-MM-DD (date-only, no timezone component). */
  startDate: string;
  endDate: string;
  dailyMinutes: number;
  status: StudyPlanStatus;
  createdAt: string;
  updatedAt: string;
}

/** Session row with joined display names, returned by the session APIs. */
export interface StudySessionRecord {
  id: string;
  studyPlanId: string | null;
  subjectId: string | null;
  topicId: string | null;
  examId: string | null;
  scheduledDate: string;
  /** HH:MM local or null. */
  startTime: string | null;
  durationMinutes: number;
  sessionType: SessionType;
  status: SessionStatus;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subjectName?: string | null;
  topicName?: string | null;
}

/** Goal row; progressMinutes is recomputed from real completed sessions. */
export interface StudyGoalRecord {
  id: string;
  title: string;
  description: string | null;
  targetDate: string | null;
  targetMinutes: number | null;
  completedMinutes: number;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  progressMinutes?: number;
}

/** Aggregated payload served by GET /api/student/study-dashboard. */
export interface StudyDashboardData {
  today: string;
  nextExam: NextExamSummary | null;
  upcomingExams: NextExamSummary[];
  todaySessions: StudySessionRecord[];
  week: {
    start: string;
    end: string;
    completedMinutes: number;
    plannedMinutes: number;
    completionPercent: number;
  };
  streakDays: number;
  activeGoals: StudyGoalRecord[];
  activePlan: StudyPlanRecord | null;
  recommendation: string | null;
}

export interface NextExamSummary {
  id: string;
  title: string;
  subjectName: string | null;
  examDate: string;
  examType: ExamType;
  targetScore: number | null;
  priority: number;
  daysLeft: number;
}

/** Optional academic context attached to a chat request. */
export interface ChatContextSelection {
  subjectId?: string;
  topicId?: string;
  /** @deprecated Use sourceIds instead. Kept for backward compat. */
  documentId?: string;
  /** Generic source IDs (documents + pasted text + images). */
  sourceIds?: string[];
}

// ---------------------------------------------------------------------------
// Phase 5B — document-grounded Q&A
// ---------------------------------------------------------------------------

/** A single retrieved passage from a document. */
export interface DocumentPassage {
  text: string;
  score: number;
  pageNumber: number | null;
}

/** Result of document retrieval for grounding a chat answer. */
export interface DocumentGroundingContext {
  documentId: string;
  documentName: string;
  originalFilename: string;
  passages: DocumentPassage[];
  totalChunks: number;
}

export interface StudySubject {
  id: string;
  name: string;
  progress: number;
  nextTopic: string;
}

export interface StudyActivity {
  id: string;
  action: string;
  subject: string;
  timeLabel: string;
}

export type NotificationKind = "reminder" | "goal" | "document";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timeLabel: string;
  unread: boolean;
}

// ---------------------------------------------------------------------------
// Phase 4D Enhancement — chat-based study time tracking
// ---------------------------------------------------------------------------

export interface ChatStudySession {
  id: string;
  userId: string;
  subjectId: string | null;
  topicId: string | null;
  conversationId: string | null;
  startedAt: string;
  endedAt: string | null;
  activeSeconds: number;
  lastActivityAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  subjectName?: string | null;
  topicName?: string | null;
}

/** Client-side tracking status. */
export type ChatStudyStatus =
  | "inactive"      // no academic context selected
  | "paused"        // context selected but tab hidden / inactive
  | "tracking";     // actively counting time

/** Lightweight breakdown of where study minutes came from. */
export interface StudyTimeBreakdown {
  plannerMinutes: number;
  chatMinutes: number;
  totalMinutes: number;
}

/** Recent chat study activity entry for the productivity dashboard. */
export interface ChatStudyActivity {
  subjectName: string;
  topicName: string | null;
  activeMinutes: number;
  date: string;
}

// ---------------------------------------------------------------------------
// Phase 4D — student productivity + personalization
// ---------------------------------------------------------------------------

export interface NextAction {
  title: string;
  reason: string;
  subject: string | null;
  topic: string | null;
  estimatedMinutes: number;
  actionType: "review_weak" | "complete_session" | "exam_prep" | "goal_push" | "practice" | "re_entry";
}

export interface ProductivityDayRecord {
  date: string;
  plannedMinutes: number;
  completedMinutes: number;
  completionPercent: number;
  sessionsCompleted: number;
  score: number;
  /** Minutes from planned study sessions. */
  plannerMinutes: number;
  /** Minutes from active chat study. */
  chatMinutes: number;
}

export interface ProductivityStreak {
  current: number;
  longest: number;
  daysLast7: number;
  daysLast30: number;
}

export interface ProductivityScore {
  value: number;
  label: string;
  explanation: string;
}

export interface RoutineRecord {
  preferredSessionMinutes: number | null;
  preferredBreakMinutes: number | null;
  preferredStudyTime: string | null;
  dailyStudyTargetMinutes: number | null;
}

export interface ProductivityDashboardData {
  today: ProductivityDayRecord;
  streak: ProductivityStreak;
  score: ProductivityScore;
  nextAction: NextAction | null;
  recommendation: string | null;
  weeklyStats: {
    totalMinutes: number;
    plannedMinutes: number;
    completionPercent: number;
    sessionsCompleted: number;
    subjectsStudied: string[];
    topicsPracticed: string[];
    chatMinutes: number;
    plannerMinutes: number;
  };
  history: ProductivityDayRecord[];
  routine: RoutineRecord;
  notifications: ProductivityNotification[];
  recentChatStudy: ChatStudyActivity[];
}

export interface ProductivityNotification {
  id: string;
  kind: "exam_approaching" | "goal_behind" | "streak_at_risk" | "weak_topic" | "session_due";
  title: string;
  body: string;
  severity: "info" | "warning" | "urgent";
}

// ---------------------------------------------------------------------------
// Phase 5A — Agentic Chat Core: context sources
// ---------------------------------------------------------------------------

/** Row shape for the context_sources table (pasted text, images). */
export interface ContextSourceRecord {
  id: string;
  userId: string;
  type: "pasted_text" | "image";
  name: string | null;
  contentText: string | null;
  storagePath?: string | null;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  contentHash?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  processingStatus?: string | null;
  processingError?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
